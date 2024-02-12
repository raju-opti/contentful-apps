/* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events, jsx-a11y/anchor-is-valid */
import React, { useState, useEffect, useRef } from 'react';
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
import { useLatest } from '../hook';
import { VARIATION_CONTAINER_ID } from '../AppPage/constants';
import {  checkAndGetField, checkAndSetField, randStr, isCloseToExpiration, resolvablePromise, entryHasFxFields } from '../util';
import { getResultsUrl } from '../optimizely-client';

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
      isFx, reloadNeeded, primaryEnvironment, experiments, contentTypes, referenceInfo 
    }) {
      state.isFx = isFx;
      state.reloadNeeded = reloadNeeded;
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

const getInitialValue = (sdk) => ({
  loaded: false,
  isFx: false,
  reloadNeeded: false,
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

const fetchInitialData = async (sdk, client, slideInLevelPromise) => {
  console.log('fetching inital data ====>', document.referrer);
  const { space, ids, locales, entry } = sdk;

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
    if (!entryHasFxFields(entry)) {
      const variationContainer = await space.getContentType(VARIATION_CONTAINER_ID);
      console.log('varcon', variationContainer.fields);
      // await wait(999999);

      const variationContainerFields = variationContainer.fields.map((f) => f.id);

      let updateNeeded = false;

      if (!variationContainerFields.includes(fieldNames.flagKey)) {
        updateNeeded = true;
        variationContainer.fields.push(
          {
            id: 'flagKey',
            name: 'Flag Key',
            type: 'Symbol',
          },
        );
      }
      if (!variationContainerFields.includes(fieldNames.environment)) {
        updateNeeded = true;
        variationContainer.fields.push(
          {
            id: 'environment',
            name: 'Environment Key',
            type: 'Symbol',
          },
        );
      }
      
      if (!variationContainerFields.includes(fieldNames.revision)) {
        updateNeeded = true;
        variationContainer.fields.push({
          id: 'revision',
          name: 'Revision ID',
          type: 'Symbol',
          omitted: true,
        });
      }

      if (updateNeeded) {
        console.log('updating variation container');
        await space.updateContentType(variationContainer);
      }

      console.log('sliding in entry');
      sdk.navigator.openEntry(sdk.entry.getSys().id, { slideIn: true });
      const slideInLevel = await Promise.race([slideInLevelPromise, new Promise((resolve) => {
        setTimeout(() => resolve(-1), 5000);
      })]);

      console.log('slide level ', slideInLevel);

      // if entry is in the base slive level, reopen in the same browser window
      if (slideInLevel === 0) {
        console.log('entry in base level, reopening');
        await sdk.navigator.openEntry(sdk.entry.getSys().id);
      }
    }
    
  }

  const isFx = optimizelyProjectType === ProjectType.FeatureExperimentation || fsToFxMigrated;

  const [contentTypesRes, entriesRes, experiments] = await Promise.all([
    space.getContentTypes({ order: 'name', limit: 1000 }),
    getEntriesLinkedByIds(space, ids.entry),
    isFx ? client.getRules() : client.getExperiments(),
  ]);

  const experimentKey = checkAndGetField(entry, fieldNames.experimentKey);
  const isNewEntry = !experimentKey

  let reloadNeeded = isFx && !entryHasFxFields(entry);

  //update entry with environment and flagKey if needed
  if (isFx) {
    console.log('reload needed ...', reloadNeeded);
    if (reloadNeeded) {
        sdk.dialogs.openAlert({
          title: 'Action Required',
          confirmLabel: 'Close',
          message: 'This project has been migrated to Feature Experimentation. Please refresh the page to load the updated configuration' + 
            ' and continue editing!',
        });
    }

    if (!isNewEntry && !reloadNeeded) {
      let environment = checkAndGetField(entry, fieldNames.environment);
      let flagKey = checkAndGetField(entry, fieldNames.flagKey);
      let revision = checkAndGetField(entry, fieldNames.revision);
      
      console.log('values : ', environment, flagKey, revision);

      if (!environment || !flagKey || !revision) {
        if (!environment) environment = primaryEnvironment;
        const rule = experiments.find((e) => 
          e.key === experimentKey && e.environment_key === environment
        );
  
        if (rule) {
          console.log('got rule', rule.flag_key);
          flagKey = rule.flag_key;
          entry.fields.flagKey.setValue(flagKey);
          entry.fields.environment.setValue(environment);
          entry.fields.revision.setValue(randStr());
        } else {
          console.log('rule not found', environment, experimentKey);
        }
      }
    }
  }

  return {
    isFx,
    reloadNeeded,
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

// function isCloseToExpiration(expires) {
//   const _10minutes = 600000;
//   return parseInt(expires, 10) - Date.now() <= _10minutes;
// }

export default function EditorPage(props) {
  const globalState = useMethods(methods, getInitialValue(props.sdk));
  const [state, actions] = globalState;
  const [showAuth, setShowAuth] = useState(isCloseToExpiration(props.expires));

  // const selectedId = state.selectedId;
  // const experiment = state.experiments.find(
  //   (experiment) => experiment.id.toString() === state.selectedId
  // );
  const { sdk, client } = props;
  console.log('re rendering EditorPage ...');
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

  const slideInLevelRef = useRef(resolvablePromise());

  useEffect(() => {
    sdk.navigator.onSlideInNavigation((d) => {
      slideInLevelRef.current.resolve(d.oldSlideLevel);
    });
  }, [sdk, slideInLevelRef]);

  /**
   * Fetch rule variations and experiment id for FX projects
   */
  useEffect(() => {
    let isActive = true;
    
    // const client = getLatestClient();

    if (hasExperiment && isFx && !hasVariations && client) {
      client
        .getRule(flagKey, experimentKey, experimentEnvironment)
        .then((rule) => {
          // const sdk = getLatestSdk();
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
    client,
    sdk,
    actions
  ]);

  /**
   * Fetch initial portion of data required to render initial state
   */
  useEffect(() => {
    if (!state.loaded && client) {
      fetchInitialData(sdk, client, slideInLevelRef.current.promise)
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
  }, [actions, state.loaded, client, sdk, slideInLevelRef]);

  /**
   * Pulling current experiment every 5s to get new status and variations
   */
  useEffect(() => {
    let isActive = true;
    const interval = setInterval(() => {
      if (hasExperiment && client) {
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
    client,
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
        const environment = checkAndGetField(props.sdk.entry, fieldNames.environment);
        actions.setExperiment(data, environment);
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
    if (state.loaded && hasExperiment && experimentId && client) {
      client
        .getExperimentResults(experimentId)
        .then((results) => {
          actions.setExperimentResults(experimentId, results);
          return results;
        })
        .catch(() => {});
    }
  }, [actions, hasExperiment, experimentId, client, state.loaded]);

  const getExperimentResults = (experiment) => {
    if (!experiment) {
      return undefined;
    }

    const experimentId = isFx ? experiment.experiment_id : experiment.id;
    return {
      url: getResultsUrl(sdk.parameters.installation.optimizelyProjectId, experiment.campaign_id, experimentId),
      results: state.experimentsResults[experimentId],
    };
  };

  /**
   * Handlers
   */

  const onChangeExperiment = (experiment) => {
    props.sdk.entry.fields.meta.setValue({});
    checkAndSetField(props.sdk.entry, fieldNames.flagKey, experiment.flag_key);
    checkAndSetField(props.sdk.entry, fieldNames.environment, experiment.environment_key);
    const experimentId = (isFx ? experiment.experiment_id : experiment.id) || '';
    if (experimentId) {
      props.sdk.entry.fields.experimentId.setValue(experimentId.toString());
    }
    props.sdk.entry.fields.experimentKey.setValue(experiment.key);
    checkAndSetField(props.sdk.entry, fieldNames.revision, randStr());
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
            isFx={isFx}
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
            reloadNeeded={state.reloadNeeded}
            hasVariations={experiment && state.variations.length > 0}
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
            disableEdit={state.reloadNeeded}
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
