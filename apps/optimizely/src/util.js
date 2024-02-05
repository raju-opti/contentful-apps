import { ProjectType } from "./constants";

export const getProjectType = (sdk) => {
  return sdk.parameters.installation.optimizelyProjectType;
};

export const isFxProject = (sdk) => {
  return getProjectType(sdk) === ProjectType.FeatureExperimentation;
};

export const entryHasField = (entry, field) => {
  return !!entry.fields[field];
};

// export const checkAndGetField = (entry, field) => {
//   if (entryHasField(entry, field)) {
//     return entry.fields[field].getValue();
//   }
//   return undefined;
// }

// export const checkAndSetField = async (entry, field, value) => {
//   if (entryHasField(entry, field)) {
//     return entry.fields[field].setValue(value);
//   }
// }

export const checkAndGetField = (entry, field) => {
  if (entryHasField(entry, field)) {
    return entry.fields[field].getValue();
  }
  return undefined;
}

export const checkAndSetField = async (entry, field, value) => {
  if (entryHasField(entry, field)) {
    return entry.fields[field].setValue(value);
  }
}

export const randStr = () => {
  return Math.random().toString(36).substring(2)
}

export function isCloseToExpiration(expires) {
  const _10minutes = 600000;
  return parseInt(expires, 10) - Date.now() <= _10minutes;
}
