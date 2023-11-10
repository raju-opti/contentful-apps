import { ProjectType } from "./constants";

export const getProjectType = (sdk) => {
  return sdk.parameters.installation.optimizelyProjectType;
};

export const isFxProject = (sdk) => {
  return getProjectType(sdk) === ProjectType.FeatureExperimentation;
};
