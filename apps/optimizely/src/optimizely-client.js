export default class OptimizelyClient {
  constructor({ project, accessToken, onReauth }) {
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new Error('You must provide a valid access token!');
    }

    this.accessToken = accessToken;
    this.project = project;
    this.baseURL = 'https://api.optimizely.com/v2';
    this.fxBaseUrl = 'https://api.optimizely.com/flags/v1';
    this.onReauth = onReauth;
  }

  makeRequest = async (url) => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (response.ok) {
      return await response.json();
    }

    console.log(response);

    // reauthing should hopefully fix the issue
    this.onReauth();
  };

  _getItemsPerPage = async (item, isFx) => {
    let items = [];
    const PER_PAGE = 100;
    const MAX_REQUESTS = 10;

    for (let i = 1; i <= MAX_REQUESTS; i++) {
      const results = await this.makeRequest(this._getItemsUrl(PER_PAGE, i, item));
      items = [...items, ...results];
      if (results.length < PER_PAGE) {
        break;
      }
    }

    if (item === 'experiment') {
      items = items.filter((experiment) => {
        return experiment.status !== 'archived';
      });
    }

    items = items.sort((a, b) => {
      const nameA = a.name.toUpperCase();
      const nameB = b.name.toUpperCase();

      if (nameA < nameB) {
        return -1;
      }
      if (nameA > nameB) {
        return 1;
      }
      return 0;
    });

    return items;
  };

  _getItemsUrl = (perPage, page, item) => {
    switch (item) {
      case 'project':
        return `${this.baseURL}/projects?per_page=${perPage.toString()}&page=${page.toString()}`;
      case 'experiment':
        return `${this.baseURL}/experiments?project_id=${
          this.project
        }&per_page=${perPage.toString()}&page=${page.toString()}`;
      default:
        return '';
    }
  };

  getProjects() {
    return this._getItemsPerPage('project');
  }

  getExperiment = (experimentId) => {
    return this.makeRequest(`${this.baseURL}/experiments/${experimentId}`);
  };

  getExperiments = async () => {
    return this._getItemsPerPage('experiment');
  };

  getRules = async () => {
    let url = `/projects/${this.project}/rules` +
      '?rule_types=a/b,mab&archived=false&environments=production&page_window=1&per_page=1';

    let items = [];

    while(true) {
      const response = await this.makeRequest(`${this.fxBaseUrl}${url}`);
      console.log(response);
      if (response.items) {
        items = [...items, ...response.items];
      }
      if (response.next_url) {
        ([url] = response.next_url);
      } else {
        break;
      }
    }
    console.log(items);
    return items;
  };

  getRule = async (flagKey, ruleKey) => {
    return this.makeRequest(`${this.fxBaseUrl}/projects/${this.project}/flags/${flagKey}/environments/production/rules/${ruleKey}`);
  }

  getExperimentResults = (experimentId) => {
    return this.makeRequest(`${this.baseURL}/experiments/${experimentId}/results`);
  };

  getResultsUrl = (campaignUrl, experimentId) => {
    return `https://app.optimizely.com/v2/projects/${this.project}/results/${campaignUrl}/experiments/${experimentId}`;
  };
}
