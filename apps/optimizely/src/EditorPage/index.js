/* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events, jsx-a11y/anchor-is-valid */
import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { css } from 'emotion';
import useMethods from 'use-methods';
import tokens from '@contentful/forma-36-tokens';
import { Note, Paragraph, Modal } from '@contentful/forma-36-react-components';
import StatusBar from './subcomponents/status-bar';
import ReferencesSection from './subcomponents/references-section';
import ExperimentSection from './subcomponents/experiment-section';
import VariationsSection from './subcomponents/variations-section';
import SectionSplitter from './subcomponents/section-splitter';
import { SDKContext, GlobalStateContext } from './subcomponents/all-context';
import prepareReferenceInfo, { COMBINED_LINK_VALIDATION_CONFLICT } from './reference-info';
import useInterval from '@use-it/interval';
import ConnectButton from '../ConnectButton';
import { ProjectType, fieldNames } from '../constants';
import { useCmaClient, useLatest } from '../hook';
import { VARIATION_CONTAINER_ID } from '../AppPage/constants';
import {  checkAndGetField, checkAndSetField, randStr, isCloseToExpiration } from '../util';
import { createClient } from 'contentful-management';
import { act } from '@testing-library/react';

const styles = {
  root: css({
    margin: tokens.spacingXl,
  }),
  paragraph: css({
    marginBottom: tokens.spacingM,
  }),
  link: css({
    cursor: 'pointer',
    textDecoration: 'underline',
  }),
};

const wait = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const updatetFxRuleFields = (fxRule) => {
  const variations = fxRule.variations && Object.values(fxRule.variations);
  const campaignId = fxRule.layer_id;
  const status = fxRule.enabled ? 'enabled' : 'disabled';

  fxRule.variations = variations;
  fxRule.campaign_id = campaignId;
  fxRule.status = status;
}

const methods = (state) => {
  return {
    setInitialData({ 
      isFx, primaryEnvironment, experiments, contentTypes, referenceInfo 
    }) {
      state.isFx = isFx;
      state.primaryEnvironment = primaryEnvironment;
      state.experiments = experiments;
      state.contentTypes = contentTypes;
      state.referenceInfo = referenceInfo;
      state.loaded = true;
    },
    setError(message) {
      state.error = message;
    },
    setExperiment(experimentKey, environment) {
      state.experimentKey = experimentKey;
      state.environment = environment;
      state.meta = {};
    },
    setVariations(variations) {
      state.variations = variations;
    },
    setEntry(id, entry) {
      state.entries[id] = entry;
    },
    setMeta(meta) {
      state.meta = meta;
    },
    setExperimentResults(id, results) {
      state.experimentsResults[id] = results;
    },
    updateFxExperimentRule(key, environment, fxRule) {
      const index = state.experiments.findIndex(
        (experiment) => experiment.key === key && experiment.environment_key === environment
      );
      if (index !== -1) {
        const expriment = { ...state.experiments[index], ...fxRule };
        updatetFxRuleFields(expriment);
        state.experiments[index] = expriment;
      }
    },
    updateExperiment(id, experiment) {
      const index = state.experiments.findIndex(
        (experiment) => experiment.id.toString() === id.toString()
      );
      if (index !== -1) {
        state.experiments[index] = experiment;
      }
    },
  };
};

const entryValueGetter = (locale) => {
  return (entry, field) => {
    if (entry.fields[field]) {
      return entry.fields[field][locale];
    }
    return undefined;
  }
}

const entryValueSetter = (locale) => {
  return (entry, field, value) => {
    if (!entry.fields[field]) {
      entry.fields[field] = {};
    }

    entry.fields[field][locale] = value;
  }
}

const getInitialValue = (sdk) => ({
  loaded: false,
  isFx: false,
  error: false,
  experiments: [],
  contentTypes: [],
  meta: sdk.entry.fields.meta.getValue() || {},
  variations: sdk.entry.fields.variations.getValue() || [],
  experimentKey: sdk.entry.fields.experimentKey.getValue(),
  environment: checkAndGetField(sdk.entry, fieldNames.environment),
  flagKey: checkAndGetField(sdk.entry, fieldNames.flagKey),
  entries: {},
  experimentsResults: {},
});

/**
 * Get entries linked to a list of entries
 *
 * @description Due to Contentful auto-saving after the entry has been created but not before the getEntries might return incorrect response and require a retry until the linked has been created by Contentful
 *
 */
const getEntriesLinkedByIds = async (space, entryIds) => {
  const DELAY_IN_MILLISECONDS = 5000;
  const RETRY_LIMIT = 2;

  let retries = 0;
  let entriesRes = null;

  while (retries < RETRY_LIMIT) {
    entriesRes = await space.getEntries({
      links_to_entry: entryIds,
      skip: 0,
      limit: 1000,
    });

    if (entriesRes.items.length) {
      return entriesRes;
    } else {
      retries++;
      await new Promise((resolve) =>
        setTimeout(() => {
          resolve();
        }, DELAY_IN_MILLISECONDS)
      );
    }
  }

  return entriesRes;
};

const fetchInitialDataC = async (sdk, cma, client) => {
  const { ids, locales } = sdk;

  const { optimizelyProjectType, optimizelyProjectId } = sdk.parameters.installation;

  let fsToFxMigrated = false;
  let primaryEnvironment = '';

  if (optimizelyProjectType !== ProjectType.FeatureExperimentation) {
    const [project, environments] = await Promise.all([
      client.getProject(optimizelyProjectId),
      client.getProjectEnvironments(optimizelyProjectId),
    ]);
    if (project.is_flags_enabled) {
      fsToFxMigrated = true;
    }
    environments.forEach((e) => {
      if (e.is_primary) {
        primaryEnvironment = e.key;
      }
    });
  }

  // update variation container content type if needed
  if (fsToFxMigrated) {
    const entryFields = Object.keys(sdk.entry.fields);
    if (!entryFields.includes(fieldNames.flagKey) || !entryFields.includes(fieldNames.environment)) {
      const variationContainer = await cma.environment.getContentType(VARIATION_CONTAINER_ID);
      if (!entryFields.includes(fieldNames.flagKey)) {
        variationContainer.fields.push(
          {
            id: 'flagKey',
            name: 'Flag Key',
            type: 'Symbol',
          },
        );
      }
      if (!entryFields.includes(fieldNames.environment)) {
        variationContainer.fields.push(
          {
            id: 'environment',
            name: 'Environment Key',
            type: 'Symbol',
          },
        );
      }

      console.log(variationContainer);

      await variationContainer.update();
      // this will refresh the page and sdk.entry in the new page will have all variation container fields
      // await sdk.navigator.openEntry(sdk.entry.getSys().id);
    }
  }

  const isFx = optimizelyProjectType === ProjectType.FeatureExperimentation || fsToFxMigrated;

  const [contentTypesRes, entriesRes, experiments] = await Promise.all([
    sdk.space.getContentTypes({ order: 'name', limit: 1000 }),
    getEntriesLinkedByIds(sdk.space, ids.entry),
    isFx ? client.getRules() : client.getExperiments(),
  ]);

  const defaultLocale = locales.default;
  const getEntryValue = entryValueGetter(defaultLocale);
  const setEntryValue = entryValueSetter(defaultLocale);

  const experimentKey = getEntryValue(cma.entry, fieldNames.experimentKey);
  const isNewEntry = !experimentKey

  console.log(isFx, isNewEntry);
  //update entry with environment and flagKey if needed
  if (isFx && !isNewEntry) {
    // let environment = checkAndGetField(cma.entry, fieldNames.environment);
    // let flagKey = checkAndGetField(cma.entry, fieldNames.flagKey);
    // let revision = checkAndGetField(cma.entry, fieldNames.revision);
    let environment = getEntryValue(cma.entry, fieldNames.environment);
    let flagKey = getEntryValue(cma.entry, fieldNames.flagKey);


    if (!environment || !flagKey) {
      if (!environment) environment = primaryEnvironment;
      const rule = experiments.find((e) => 
        e.key === experimentKey && e.environment_key === environment
      );

      if (rule) {
        flagKey = rule.flag_key;
        setEntryValue(cma.entry, fieldNames.flagKey, flagKey);
        setEntryValue(cma.entry, fieldNames.environment, flagKey);
        // entry.fields.flagKey.setValue(flagKey);
        // entry.fields.environment.setValue(environment);
        // entry.fields.revision.setValue(randStr());
        await cma.entry.update();
      }
    }
  }

  return {
    isFx,
    primaryEnvironment,
    experiments,
    contentTypes: contentTypesRes.items,
    referenceInfo: prepareReferenceInfo({
      contentTypes: contentTypesRes.items,
      entries: entriesRes.items,
      variationContainerId: ids.entry,
      variationContainerContentTypeId: ids.contentType,
      defaultLocale: locales.default,
    }),
  };
};

// const fetchInitialData = async (sdk, client) => {
//   const { space, ids, locales, entry } = sdk;

//   const { optimizelyProjectType, optimizelyProjectId } = sdk.parameters.installation;

//   let fsToFxMigrated = false;
//   let primaryEnvironment = '';

//   if (optimizelyProjectType !== ProjectType.FeatureExperimentation) {
//     const [project, environments] = await Promise.all([
//       client.getProject(optimizelyProjectId),
//       client.getProjectEnvironments(optimizelyProjectId),
//     ]);
//     if (project.is_flags_enabled) {
//       fsToFxMigrated = true;
//     }
//     environments.forEach((e) => {
//       if (e.is_primary) {
//         primaryEnvironment = e.key;
//       }
//     });
//   }

//   // update variation container content type if needed
//   if (fsToFxMigrated) {
//     const entryFields = Object.keys(entry.fields);
//     if (!entryFields.includes(fieldNames.flagKey) || !entryFields.includes(fieldNames.environment)
//         || !entryFields.includes(fieldNames.revision)) {
//       const variationContainer = await space.getContentType(VARIATION_CONTAINER_ID);
//       if (!entryFields.includes(fieldNames.flagKey)) {
//         variationContainer.fields.push(
//           {
//             id: 'flagKey',
//             name: 'Flag Key',
//             type: 'Symbol',
//           },
//         );
//       }
//       if (!entryFields.includes(fieldNames.environment)) {
//         variationContainer.fields.push(
//           {
//             id: 'environment',
//             name: 'Environment Key',
//             type: 'Symbol',
//           },
//         );
//       }
      
//       if (!entryFields.includes(fieldNames.revision)) {
//         variationContainer.fields.push({
//           id: 'revision',
//           name: 'Revision ID',
//           type: 'Symbol',
//           omitted: true,
//         });
//       }
//       await space.updateContentType(variationContainer);
//       // this will refresh the page and sdk.entry in the new page will have all variation container fields
//       // await sdk.navigator.openEntry(sdk.entry.getSys().id);
//     }
//   }

//   // const cma = createClient(
//   //   { apiAdapter: sdk.cmaAdapter },
//   //   {
//   //     type: 'plain',
//   //     defaults: {
//   //       environmentId: sdk.ids.environment,
//   //       spaceId: sdk.ids.space,
//   //     },
//   //   }
//   // );

//   // const centry = await cma.entry.get({ entryId: sdk.entry.getSys().id });
//   // console.log(centry);

//   // const cma = createClient(
//   //   { apiAdapter: sdk.cmaAdapter },
//   // )
  
//   // const cspace = await cma.getSpace(sdk.ids.space)
//   // const environment = await cspace.getEnvironment(sdk.ids.environment)
//   // const centry = await environment.getEntry(sdk.entry.getSys().id);

//   const et = await sdk.space.getEntry(sdk.entry.getSys().id);
//   console.log('reaad entry ', et);


//   const isFx = optimizelyProjectType === ProjectType.FeatureExperimentation || fsToFxMigrated;

//   const [contentTypesRes, entriesRes, experiments] = await Promise.all([
//     space.getContentTypes({ order: 'name', limit: 1000 }),
//     getEntriesLinkedByIds(space, ids.entry),
//     isFx ? client.getRules() : client.getExperiments(),
//   ]);


//   const experimentKey = checkAndGetField(entry, fieldNames.experimentKey);
//   const isNewEntry = !experimentKey

//   console.log(isFx, isNewEntry);
//   //update entry with environment and flagKey if needed
//   if (isFx && !isNewEntry) {
//     let environment = checkAndGetField(entry, fieldNames.environment);
//     let flagKey = checkAndGetField(entry, fieldNames.flagKey);
//     let revision = checkAndGetField(entry, fieldNames.revision);

//     centry.fields[fieldNames.environment] = { 'en-US' : environment };
//     centry.fields[fieldNames.flagKey] = { 'en-US' : flagKey };;
//     // centry.fields[fieldNames.revision]['en-US'] = revision;

//     // if (!environment || !flagKey || !revision) {
//     //   if (!environment) environment = primaryEnvironment;
//     //   const rule = experiments.find((e) => 
//     //     e.key === experimentKey && e.environment_key === environment
//     //   );

//     //   console.log(rule, environment, 'rulee');
//     //   if (rule) {
//     //     flagKey = rule.flag_key;
//     //     entry.fields.flagKey.setValue(flagKey);
//     //     entry.fields.environment.setValue(environment);
//     //     entry.fields.revision.setValue(randStr());
//     //   }
//     // }
//     const res = await centry.update();
//     console.log('update res', res);
//   }

//   return {
//     isFx,
//     primaryEnvironment,
//     experiments,
//     contentTypes: contentTypesRes.items,
//     defaultLocale,
//     referenceInfo: prepareReferenceInfo({
//       contentTypes: contentTypesRes.items,
//       entries: entriesRes.items,
//       variationContainerId: ids.entry,
//       variationContainerContentTypeId: ids.contentType,
//       defaultLocale: locales.default,
//     }),
//   };
// };

// function isCloseToExpiration(expires) {
//   const _10minutes = 600000;
//   return parseInt(expires, 10) - Date.now() <= _10minutes;
// }


export default function EditorPage(props) {
  console.log(props.sdk, props.sdk.entry);
  const globalState = useMethods(methods, getInitialValue(props.sdk));
  const [state, actions] = globalState;
  const [showAuth, setShowAuth] = useState(isCloseToExpiration(props.expires));

  // const selectedId = state.selectedId;
  // const experiment = state.experiments.find(
  //   (experiment) => experiment.id.toString() === state.selectedId
  // );

  const { isFx, primaryEnvironment, experimentKey, environment } = state;
  const experimentEnvironment = environment || primaryEnvironment;

  const experiment = state.experiments.find(
    (experiment) => {
      if (!isFx) {
        return experiment.key === experimentKey;
      }
      return experiment.key === experimentKey && experiment.environment_key === experimentEnvironment;
    }
  );
  
  const experimentId = experiment && (isFx ? experiment.experiment_id : experiment.id);

  const getLatestClient = useLatest(props.client);
  const getLatestSdk = useLatest(props.sdk);
  
  const hasExperiment = !!experiment;
  const flagKey = experiment && experiment.flag_key;
  const hasVariations = experiment && experiment.variations;

  const getEntryValue = entryValueGetter(props.sdk.locales.default);
  const setEntryValue = entryValueSetter(props.sdk.locales.default);

  /**
   * Fetch rule variations and experiment id for FX projects
   */
  useEffect(() => {
    let isActive = true;
    
    const client = getLatestClient();

    if (hasExperiment && isFx && !hasVariations) {
      client
        .getRule(flagKey, experimentKey, experimentEnvironment)
        .then((rule) => {
          const sdk = getLatestSdk();
          // update experiment id field of the entry
          if (sdk.entry.fields.experimentKey.getValue() === experimentKey
            && (!sdk.entry.fields.environment.getValue() || sdk.entry.fields.environment.getValue() === experimentEnvironment)) {
              return sdk.entry.fields.experimentId.setValue(rule.experiment_id.toString()).then(() => rule);
          }
          return rule;
        }).then((rule) => {
          if (isActive) {
            actions.updateFxExperimentRule(experimentKey, experimentEnvironment, rule);
          }
        })
        .catch((err) => {
          actions.setError('Unable to load variations');
        });
    }

    return () => {
      isActive = false;
    }
  }, [
    hasExperiment,
    isFx,
    experimentKey,
    experimentEnvironment,
    flagKey,
    hasVariations,
    getLatestClient,
    getLatestSdk,
    actions
  ]);

  const [ cmaDone, cma, cmaError ] = useCmaClient(props.sdk, 10);
  /**
   * Fetch initial portion of data required to render initial state
   */
  useEffect(() => {
    let isActive = true;

    if (cmaDone) {
      if (cmaError) {
        actions.setError('Unable to load initial data');
        return;
      }
      const client = getLatestClient();
      fetchInitialDataC(props.sdk, cma, props.client)
        .then((data) => {
          if (data.isFx) {
            data.experiments.forEach((experiment) => {
              updatetFxRuleFields(experiment);
            });
          }
          actions.setInitialData(data);
          return data;
        })
        .catch((err) => {
          console.log(err);
          actions.setError('Unable to load initial data');
        });
    }

    // fetchInitialData(props.sdk, props.client)
    //   .then((data) => {
    //     if (data.isFx) {
    //       data.experiments.forEach((experiment) => {
    //         updatetFxRuleFields(experiment);
    //       });
    //     }
    //     actions.setInitialData(data);
    //     return data;
    //   })
    //   .catch((err) => {
    //     console.log(err);
    //     actions.setError('Unable to load initial data');
    //   });

      return () => {
        isActive = false;
      }
  }, [actions, getLatestClient, props.sdk, cmaDone, cma, cmaError]);

  /**
   * Pulling current experiment every 5s to get new status and variations
   */
  useEffect(() => {
    let isActive = true;
    const interval = setInterval(() => {
      if (hasExperiment) {
        const client = getLatestClient();

        if (isFx) {
          client
            .getRule(flagKey, experimentKey, experimentEnvironment)
            .then((rule) => {
              if (isActive) {
                actions.updateFxExperimentRule(experimentKey, experimentEnvironment, rule);
              }
            })
            .catch(() => {});
        } else {
          client
            .getExperiment(experimentId)
            .then((updatedExperiment) => {
              if (isActive) {
                actions.updateExperiment(experimentId, updatedExperiment);
              }
            })
            .catch(() => {});
        }        
      }
    }, 5000);

    return () => {
      clearInterval(interval);
      isActive = false;
    }
  }, [
    hasExperiment,
    isFx,
    experimentKey,
    experimentEnvironment,
    experimentId,
    flagKey,
    getLatestClient,
    actions
  ]);  

  // useInterval(() => {
  //   if (state.experimentId) {
  //     props.client
  //       .getExperiment(state.experimentId)
  //       .then((experiment) => {
  //         actions.updateExperiment(state.experimentId, experiment);
  //         return experiment;
  //       })
  //       .catch(() => {});
  //   }
  // }, 5000);

  /*
   * Poll to see if we need to show the reauth flow preemptively
   */
  useInterval(() => {
    setShowAuth(isCloseToExpiration(props.expires));
  }, 5000);

  /**
   * Subscribe for changes in entry
   */
  useEffect(() => {
    // const unsubsribeExperimentChange = props.sdk.entry.fields.experimentId.onValueChanged(
    //   (data) => {
    //     console.log('exp id change .. ', data);
    //     actions.setSelectedId(data);
    //   }
    // );
    const unsubsribeExperimentChange = props.sdk.entry.fields.experimentKey.onValueChanged(
      (data) => {
        console.log('=============== exp change ================ ', data);
        // const environment = checkAndGetField(props.sdk.entry, fieldNames.environment);
        // actions.setExperiment(data, environment);
      }
    );
    const unsubscribeVariationsChange = props.sdk.entry.fields.variations.onValueChanged((data) => {
      actions.setVariations(data || []);
    });
    const unsubscribeMetaChange = props.sdk.entry.fields.meta.onValueChanged((data) => {
      actions.setMeta(data || {});
    });
    return () => {
      unsubsribeExperimentChange();
      unsubscribeVariationsChange();
      unsubscribeMetaChange();
    };
  }, [
    actions,
    props.sdk.entry
  ]);

  const experimentName = experiment && experiment.name;
  /**
   * Update title every time experiment is changed
   */
  useEffect(() => {
    if (state.loaded) {
      const title = hasExperiment ? `[Optimizely] ${experimentName}` : '';
      props.sdk.entry.fields.experimentTitle.setValue(title);
    }
  }, [hasExperiment, experimentName, props.sdk.entry.fields.experimentTitle, state.loaded]);

  /**
   * Fetch experiment results every time experiment is changed
   */
  useEffect(() => {
    const client = getLatestClient();

    if (state.loaded && hasExperiment && experimentId) {
      client
        .getExperimentResults(experimentId)
        .then((results) => {
          actions.setExperimentResults(experimentId, results);
          return results;
        })
        .catch(() => {});
    }
  }, [actions, hasExperiment, experimentId, getLatestClient, state.loaded]);

  const getExperimentResults = (experiment) => {
    if (!experiment) {
      return undefined;
    }

    const experimentId = isFx ? experiment.experiment_id : experiment.id;
    return {
      url: props.client.getResultsUrl(experiment.campaign_id, experimentId),
      results: state.experimentsResults[experimentId],
    };
  };

  /**
   * Handlers
   */
  const onChangeExperiment = async (experiment) => {
    setEntryValue(cma.entry, fieldNames.meta, {});
    setEntryValue(cma.entry, fieldNames.experimentKey, experiment.key);
    const experimentId = (isFx ? experiment.experiment_id : experiment.id) || '';
    setEntryValue(cma.entry, fieldNames.environment, experimentId.toString());    
    if (isFx) {
      setEntryValue(cma.entry, fieldNames.flagKey, experiment.flag_key);
      setEntryValue(cma.entry, fieldNames.environment, experiment.environment_key);
    }
    try {
      await cma.entry.update();
      actions.setExperiment(experiment.key, experiment.environment_key);
    } catch (err) {
      actions.setError('Error updating entry, please retry');
    }

    // props.sdk.entry.fields.meta.setValue({});
    // checkAndSetField(props.sdk.entry, fieldNames.flagKey, experiment.flag_key);
    // checkAndSetField(props.sdk.entry, fieldNames.environment, experiment.environment_key);
    // const experimentId = (isFx ? experiment.experiment_id : experiment.id) || '';
    // if (experimentId) {
    //   props.sdk.entry.fields.experimentId.setValue(experimentId.toString());
    // }
    // props.sdk.entry.fields.experimentKey.setValue(experiment.key);
    // checkAndSetField(props.sdk.entry, fieldNames.revision, randStr());
  };

  const onLinkVariation = async (variation) => {
    const data = await props.sdk.dialogs.selectSingleEntry({
      locale: props.sdk.locales.default,
      contentTypes: state.referenceInfo.linkContentTypes,
    });

    if (!data) {
      return;
    }

    const values = props.sdk.entry.fields.variations.getValue() || [];
    const meta = props.sdk.entry.fields.meta.getValue() || {};
    props.sdk.entry.fields.meta.setValue({
      ...meta,
      [variation.key]: data.sys.id,
    });
    props.sdk.entry.fields.variations.setValue([
      ...values,
      {
        sys: {
          type: 'Link',
          id: data.sys.id,
          linkType: 'Entry',
        },
      },
    ]);
  };

  const onOpenEntry = (entryId) => {
    props.sdk.navigator.openEntry(entryId, { slideIn: true });
  };

  const onCreateVariation = async (variation, contentTypeId) => {
    const data = await props.sdk.navigator.openNewEntry(contentTypeId, {
      slideIn: true,
    });

    if (!data) {
      return;
    }

    const values = props.sdk.entry.fields.variations.getValue() || [];
    const meta = props.sdk.entry.fields.meta.getValue() || {};

    props.sdk.entry.fields.meta.setValue({
      ...meta,
      [variation.key]: data.entity.sys.id,
    });
    props.sdk.entry.fields.variations.setValue([
      ...values,
      {
        sys: {
          type: 'Link',
          id: data.entity.sys.id,
          linkType: 'Entry',
        },
      },
    ]);
  };

  const onRemoveVariation = (entryId, variation) => {
    const values = props.sdk.entry.fields.variations.getValue() || [];
    const meta = props.sdk.entry.fields.meta.getValue() || {};
    if (variation) {
      delete meta[variation.key];
    }
    props.sdk.entry.fields.meta.setValue(meta);
    props.sdk.entry.fields.variations.setValue(values.filter((item) => item.sys.id !== entryId));
  };

  const onClearVariations = () => {
    props.sdk.entry.fields.meta.setValue({});
    props.sdk.entry.fields.variations.setValue([]);
  };

  const { combinedLinkValidationType } = state.referenceInfo || {};
  if (combinedLinkValidationType === COMBINED_LINK_VALIDATION_CONFLICT) {
    return (
      <Note noteType="negative" title="Conflict">
        Validations of reference fields in incoming references yield conflicting references for the
        Variation Container. Loosen validations or change incoming references so there is at least
        one shared Content Type validation.
      </Note>
    );
  }

  return (
    <SDKContext.Provider value={props.sdk}>
      <GlobalStateContext.Provider value={globalState}>
        <Modal title="Connect with Optimizely" isShown={!props.client}>
          <Paragraph className={styles.paragraph} testId="reconnect-optimizely">
            Your Optimizely session has expired. Reconnect to continue editing.
          </Paragraph>
          <ConnectButton openAuth={props.openAuth} />
        </Modal>
        <div className={styles.root} data-test-id="editor-page">
          <StatusBar
            loaded={state.loaded}
            experiment={experiment}
            variations={state.variations}
            entries={state.entries}
            sdk = {props.sdk}
          />
          <SectionSplitter />
          {showAuth && (
            <Note noteType="warning" className={styles.paragraph}>
              Your Optimizely session will expire soon. Click here to{' '}
              <a onClick={props.openAuth} className={styles.link} data-test-id="preemptive-connect">
                connect with Optimizely.
              </a>
            </Note>
          )}
          <ReferencesSection
            loaded={state.loaded}
            references={state.loaded ? state.referenceInfo.references : []}
            sdk={props.sdk}
          />
          <SectionSplitter />
          <ExperimentSection
            loaded={state.loaded}
            disabled={experiment && state.variations.length > 0}
            sdk={props.sdk}
            isFx={state.isFx}
            experiments={state.experiments}
            experiment={experiment}
            onChangeExperiment={onChangeExperiment}
            onClearVariations={onClearVariations}
          />
          <SectionSplitter />
          <VariationsSection
            loaded={state.loaded}
            isFx={isFx}
            contentTypes={state.contentTypes}
            experiment={experiment}
            experimentResults={getExperimentResults(experiment)}
            meta={state.meta}
            variations={state.variations}
            onCreateVariation={onCreateVariation}
            onLinkVariation={onLinkVariation}
            onOpenEntry={onOpenEntry}
            onRemoveVariation={onRemoveVariation}
          />
        </div>
      </GlobalStateContext.Provider>
    </SDKContext.Provider>
  );
}

EditorPage.propTypes = {
  openAuth: PropTypes.func.isRequired,
  client: PropTypes.any.isRequired,
  expires: PropTypes.string.isRequired,
  sdk: PropTypes.shape({
    space: PropTypes.object.isRequired,
    ids: PropTypes.object.isRequired,
    locales: PropTypes.object.isRequired,
    navigator: PropTypes.shape({
      openEntry: PropTypes.func.isRequired,
      openNewEntry: PropTypes.func.isRequired,
    }).isRequired,
    dialogs: PropTypes.shape({
      selectSingleEntry: PropTypes.func.isRequired,
    }).isRequired,
    entry: PropTypes.shape({
      fields: PropTypes.shape({
        experimentId: PropTypes.object.isRequired,
        experimentKey: PropTypes.object.isRequired,
        variations: PropTypes.object.isRequired,
        meta: PropTypes.object.isRequired,
        experimentTitle: PropTypes.object.isRequired,
      }).isRequired,
      getSys: PropTypes.func.isRequired,
    }).isRequired,
    parameters: PropTypes.shape({
      installation: PropTypes.shape({
        optimizelyProjectId: PropTypes.string.isRequired,
      }).isRequired,
    }).isRequired,
  }).isRequired,
};
