import * as _ from "lodash";
import * as angular from "angular";
import * as moment from "moment";

export default class GnocchiDatasource {
    name: string;
    type: string;
    version: number;
    supportMetrics: boolean;
    default_headers: any;
    withCredentials: boolean;
    domain: string;
    project: string;
    username: string;
    password: string;
    auth_mode: string;
    roles: string;
    url: string;
    keystone_endpoint: string;

    constructor(instanceSettings, private $q, private backendSrv, private templateSrv) {
      this.type = 'gnocchi';
      this.name = instanceSettings.name;
      this.supportMetrics = true;
      this.version = null;

      this.default_headers = {
        'Content-Type': 'application/json',
      };

      this.keystone_endpoint = null;
      this.url = this.sanitize_url(instanceSettings.url);

      if (instanceSettings.jsonData) {
        this.auth_mode = instanceSettings.jsonData.mode;
        this.project = instanceSettings.jsonData.project;
        this.username = instanceSettings.jsonData.username;
        this.password = instanceSettings.jsonData.password;
        this.roles = instanceSettings.jsonData.roles;
        this.domain = instanceSettings.jsonData.domain;
        if (this.domain === undefined || this.domain === "") {
          this.domain = 'default';
        }
      }

      if (this.roles === undefined || this.roles === "") {
        this.roles = 'admin';
      }

      if (instanceSettings.basicAuth || instanceSettings.withCredentials) {
          this.withCredentials = true;
      }

      // If the URL starts with http, we are in direct mode
      if (instanceSettings.basicAuth) {
        this.default_headers["Authorization"] = instanceSettings.basicAuth;

      } else if (this.auth_mode === "token"){
        this.default_headers['X-Auth-Token'] = instanceSettings.jsonData.token;

      } else if (this.auth_mode === "noauth"){
        this.default_headers['X-Project-Id'] = this.project;
        this.default_headers['X-User-Id'] = this.username;
        this.default_headers['X-Domain-Id'] = this.domain;
        this.default_headers['X-Roles'] = this.roles;

      } else if (this.auth_mode === "keystone"){
        this.url = null;
        this.keystone_endpoint = this.sanitize_url(instanceSettings.url);
      }
    }

    ////////////////
    // Plugins API
    ////////////////

    query(options: any) {
      var targets = _.filter(options.targets, (target: any) => { return !target.hide; });
      var promises = _.map(targets, (target: any) => {
        // Ensure target is valid
        var default_measures_req = {
          url: null,
          data: null,
          method: null,
          params: {
            'aggregation': null,
            'reaggregation': null,
            'start': options.range.from.toISOString(),
            'end': null,
            'stop': null,
            'granularity': null,
            'filter': null,
            'needed_overlap': null,
            'fill': null,
            'details': null,
            'metric': null
          }
        };
        if (options.range.to){
          // NOTE(sileht): Gnocchi API looks inconsistente
          default_measures_req.params.end = options.range.to.toISOString();
          default_measures_req.params.stop = options.range.to.toISOString();
        }

        var resource_type = target.resource_type;
        var metric_regex;
        var resource_search;
        var resource_id;
        var metric_id;
        var user_label;
        var granularity;
        var operations;

        try {
          this.checkMandatoryFields(target);

          metric_regex = this.templateSrv.replace(target.metric_name, options.scopedVars, 'regex');
          resource_search = this.templateSrv.replace(target.resource_search, options.scopedVars, this.formatQueryTemplate);
          operations = this.templateSrv.replace(target.operations, options.scopedVars, this.formatUnsupportedMultiValue("Operations"));
          resource_id = this.templateSrv.replace(target.resource_id, options.scopedVars, this.formatUnsupportedMultiValue("Resource ID"));
          metric_id = this.templateSrv.replace(target.metric_id, options.scopedVars, this.formatUnsupportedMultiValue("Metric ID"));
          user_label = this.templateSrv.replace(target.label, options.scopedVars, this.formatLabelTemplate);
          granularity = this.templateSrv.replace(target.granularity, options.scopedVars, this.formatUnsupportedMultiValue("Granularity"));

          if ((target.queryMode === "resource_search" || target.queryMode === "resource_aggregation")
              && this.isJsonQuery(resource_search)) {
            try {
              angular.toJson(angular.fromJson(resource_search));
            } catch (err) {
              throw {message: "Query JSON is malformed: " + err};
            }
          }

        } catch (err) {
          return this.$q.reject(err);
        }

        if (granularity) {
          default_measures_req.params.granularity = granularity;
        }
        if (target.queryMode !== "dynamic_aggregates") {
          default_measures_req.params.aggregation = target.aggregator;
        }

        if (target.queryMode === "dynamic_aggregates") {
          default_measures_req.url = 'v1/aggregates';
          default_measures_req.method = 'POST';
          default_measures_req.params.fill = target.fill;
          default_measures_req.params.needed_overlap = target.needed_overlap;
          default_measures_req.params.details = 'true';
          default_measures_req.data = {
              'operations': operations
          };
          if (resource_search && resource_search.trim() !== "") {
            default_measures_req.data['search'] = resource_search;
            default_measures_req.data['resource_type'] = resource_type;
          }
          return this._retrieve_aggregates(user_label || "unlabeled", default_measures_req);
        } else if (target.queryMode === "resource_search" || target.queryMode === "resource_aggregation") {
          var resource_search_req = this.buildQueryRequest(resource_type, resource_search);
          return this._gnocchi_request(resource_search_req).then((result) => {
            var re = new RegExp(metric_regex);
            var metrics = {};

            _.forEach(result, (resource) => {
              _.forOwn(resource["metrics"], (id, name) => {
                if (re.test(name)) {
                  metrics[id] = this._compute_label(user_label, resource, name, target.aggregator);
                }
              });
            });

            if (target.queryMode === "resource_search"){
                return this.$q.all(_.map(metrics, (label, id) => {
                  var measures_req = _.merge({}, default_measures_req);
                  measures_req.url = 'v1/metric/' + id + '/measures';
                  return this._retrieve_measures(label, measures_req,
                                                 target.draw_missing_datapoint_as_zero);
                }));
            } else {
              var measures_req = _.merge({}, default_measures_req);
              measures_req.url = 'v1/aggregation/metric';
              measures_req.params.metric = _.keysIn(metrics);
              measures_req.params.reaggregation = target.reaggregator;
              measures_req.params.fill = target.fill;
              if (target.needed_overlap === undefined) {
                measures_req.params.needed_overlap = 0;
              } else {
                measures_req.params.needed_overlap = target.needed_overlap;
              }
              // We don't pass draw_missing_datapoint_as_zero, this is done by fill
              return this._retrieve_measures(user_label || "unlabeled", measures_req, false);
            }
          });
        } else if (target.queryMode === "resource") {
          var resource_req = {
            url: 'v1/resource/' + resource_type + '/' + resource_id,
          };
          return this._gnocchi_request(resource_req).then((resource) => {
            var label = this._compute_label(user_label, resource, metric_regex, target.aggregator);
            default_measures_req.url = ('v1/resource/' + resource_type+ '/' +
                                        resource_id + '/metric/' + metric_regex + '/measures');
            return this._retrieve_measures(label, default_measures_req,
                                           target.draw_missing_datapoint_as_zero);
          });
        } else if (target.queryMode === "metric") {
          var metric_req = {
            url: 'v1/metric/' + metric_id,
          };
          return this._gnocchi_request(metric_req).then((metric) => {
            var label;
            if (user_label) {
              // NOTE(sileht): The resource returned is currently incomplete
              // https://github.com/gnocchixyz/gnocchi/issues/310
              label = this._compute_label(user_label, metric['resource'], metric["name"], target.aggregator);
            } else {
              label = metric_id;
            }
            default_measures_req.url = 'v1/metric/' + metric_id + '/measures';
            return this._retrieve_measures(label, default_measures_req,
                                           target.draw_missing_datapoint_as_zero);
          });
        }
      });

      return this.$q.all(promises).then((results) => {
        return { data: _.flattenDeep(results) };
      });
    }

    //////////////////////
    /// Measures helpers
    //////////////////////

    _retrieve_measures(label, reqs, draw_missing_datapoint_as_zero) {
      return this._gnocchi_request(reqs).then((result) => {
        return this._parse_measures(label, result, draw_missing_datapoint_as_zero);
      });
    }

    _retrieve_aggregates(user_label, reqs) {
      return this._gnocchi_request(reqs).then((result) => {
        if (reqs.data.search === undefined) {
          var metrics = {};
          _.forEach(result['references'], (metric) => {
            metrics[metric["id"]] = metric;
          });
          return _.map(Object.keys(result["measures"]), (mid) =>{
            return _.map(Object.keys(result["measures"][mid]), (agg) => {
              var label = this._compute_label(user_label, null, mid, agg);
              return this._parse_measures(label, result["measures"][mid][agg], false);
            });
          });
        } else {
          var resources = {};
          _.forEach(result['references'], (resource) => {
            resources[resource["id"]] = resource;
          });
          return _.map(Object.keys(result["measures"]), (rid) => {
            return _.map(Object.keys(result["measures"][rid]), (metric_name) => {
              return _.map(Object.keys(result["measures"][rid][metric_name]), (agg) => {
                var label = this._compute_label(user_label, resources[rid], metric_name, agg);
                return this._parse_measures(label, result["measures"][rid][metric_name][agg], false);
              });
            });
          });
        }
      });
    }

    _parse_measures(name, measures, draw_missing_datapoint_as_zero){
      var dps = [];
      var last_granularity;
      var last_timestamp;
      var last_value;
      // NOTE(sileht): sample are ordered by granularity, then timestamp.
      _.each(_.toArray(measures).reverse(), (metricData) => {
        var granularity = metricData[1];
        var timestamp = moment(metricData[0], moment.ISO_8601);
        var value = metricData[2];

        if (last_timestamp !== undefined){
          // We have a more precise granularity
          if (timestamp.valueOf() >= last_timestamp.valueOf()){
            return;
          }
          if (draw_missing_datapoint_as_zero) {
            var c_timestamp = last_timestamp;
            c_timestamp.subtract(last_granularity, "seconds");
            while (timestamp.valueOf() < c_timestamp.valueOf()) {
              dps.push([0, c_timestamp.valueOf()]);
              c_timestamp.subtract(last_granularity, "seconds");
            }
          }
        }
        last_timestamp = timestamp;
        last_granularity = granularity;
        last_value = value;
        dps.push([last_value, last_timestamp.valueOf()]);
      });
      return { target: name, datapoints: _.toArray(dps).reverse() };
    }

    _compute_label(label, resource, metric, aggregation){
      if (label) {
        var res = label;
        if (resource){
          _.forOwn(resource, (value, key) => {
              res = res.replace("${" + key + "}", value);
              res = res.replace("$" + key, value);
          });
        }
        res = res.replace("$metric", metric);
        res = res.replace("${metric}", metric);
        res = res.replace("$aggregation", aggregation);
        res = res.replace("${aggregation}", aggregation);
        return res;
      } else {
        return ((resource) ? resource["id"] : "no label");
      }
    }

    /////////////////////////
    /// Completion queries
    /////////////////////////

    performSuggestQuery(query, type, target) {
      var options = {url: null};
      var attribute = "id";
      var getter = function(result) {
        return _.map(result, (item) => {
          return item[attribute];
        });
      };

      if (type === 'metrics') {
        options.url = 'v1/metric';

      } else if (type === 'resources') {
        options.url = 'v1/resource/generic';

      } else if (type === 'metric_names') {
        if (target.queryMode === "resource" && target.resource_id !== "") {
          options.url = 'v1/resource/generic/' + target.resource_id;
          getter = function(result) {
            return Object.keys(result["metrics"]);
          };
        } else{
          return this.$q.when([]);
        }
      } else {
        return this.$q.when([]);
      }
      return this._gnocchi_request(options).then(getter);
    }

    metricFindQuery(query) {
      var req = { method: 'POST', url: null, data: null, params: {filter: null}};
      var resource_type;
      var display_attribute;
      var value_attribute;
      var resource_search;

      var resourceQuery = query.match(/^resources\(([^,]*),\s?([^,]*),\s?([^\)]+?),\s?([^\)]+?)\)/);
      if (resourceQuery) {
        resource_type = resourceQuery[1];
        display_attribute = resourceQuery[2];
        value_attribute = resourceQuery[3];
        resource_search = resourceQuery[4];
      } else {
        // NOTE(sileht): try legacy format
        resourceQuery = query.match(/^resources\(([^,]*),\s?([^,]*),\s?([^\)]+?)\)/);
        if (resourceQuery)  {
          resource_type = resourceQuery[1];
          display_attribute = "$" + resourceQuery[2];
          value_attribute = resourceQuery[2];
          resource_search = resourceQuery[3];
        }
      }

      if (resourceQuery) {
        if (value_attribute.charAt(0) === '$') {
          value_attribute = value_attribute.slice(1);
        }
        try {
          req.url = this.templateSrv.replace('v1/search/resource/' + resource_type);
          resource_search = this.templateSrv.replace(resource_search, {}, this.formatQueryTemplate);
          if (this.isJsonQuery(resource_search)) {
            angular.toJson(angular.fromJson(resource_search));
          }
        } catch (err) {
          return this.$q.reject(err);
        }


        if (this.isJsonQuery(resource_search)) {
          req.data = resource_search;
        } else {
          req.params.filter = resource_search;
        }

        return this._gnocchi_request(req).then((result) => {
          if ( value_attribute === "metrics" ){
            return _.flatten(_.map(result, (resource) => {
              return this._gnocchi_request(req).then((result) => {
                return _.flatten(_.map(result, (resource) => {
                    return _.keys(resource["metrics"]);
                }));
              });
            }));
          } else {
            return _.map(result, (resource) => {
              var display = this._compute_label(display_attribute, resource, "unknown", "none");
              var value = resource[value_attribute];
              return {text: display, value: value};
            });
          }
        });
      }

      var metricsQuery = query.match(/^metrics\(([^\)]+?)\)/);
      if (metricsQuery) {
        try {
          req.method = 'GET';
          req.url = 'v1/resource/generic/' + this.templateSrv.replace(metricsQuery[1]);
        } catch (err) {
          return this.$q.reject(err);
        }
        return this._gnocchi_request(req).then((resource) => {
          return _.map(Object.keys(resource["metrics"]), (m) => {
            return { text: m };
          });
        });
      }

      return this.$q.when([]);
    }

    ////////////////////////////
    /// Datasource validation
    ////////////////////////////

    testDatasource() {
      return this._gnocchi_request({'url': 'v1/resource'}).then(() => {
        return { status: "success", message: "Data source is working", title: "Success" };
      }, function(reason) {
        if (reason.status === 401) {
          return { status: "error", message: "Data source authentification fail", title: "Authentification error" };
        } else if (reason.message !== undefined && reason.message) {
          return { status: "error", message: reason.message, title: "Error" };
        } else {
          return { status: "error", message: reason || 'Unexpected error (is cors configured correctly ?)', title: "Error" };
        }
      });
    }

    ////////////////
    /// Query
    ////////////////

    buildQueryRequest(resource_type, resource_search) {
      var resource_search_req;

      if (this.isJsonQuery(resource_search)) {
        resource_search_req = {
          url: 'v1/search/resource/' + resource_type,
          method: 'POST',
          data: resource_search,
        };
      } else {
        resource_search_req = {
          url: 'v1/search/resource/' + resource_type,
          method: 'POST',
          params: {
            filter: resource_search,
          }
        };
      }
      return resource_search_req;
    }

    //////////////////////
    /// Utils
    //////////////////////

    requireVersion(version) {
      // this.version is a sum of 3 int where:
      // major  * 1000000
      // minor  * 1000
      // fix    * 1
      var deferred = this.$q.defer();
      version = this.parseVersion(version);
      if (this.version === null) {
        this._gnocchi_request({'url': ''}).then((result) => {
          console.log("Gnocchi build: " + result.build);
          if (result.build !== undefined){
            this.version = this.parseVersion(result.build);
          } else {
            // Assume 3.1.0
            this.version = 300010000;
          }
          if (this.version >= version) {
            deferred.resolve();
          } else {
            deferred.reject();
          }
        });
      } else if (this.version >= version) {
         deferred.resolve();
      } else {
         deferred.reject();
      }
      return deferred.promise;
    }

    parseVersion(version) {
        var v = version.split(".");
        var major = parseInt(v[0]);
        var minor = parseInt(v[1]);
        var fix = parseInt(v[2]);
        if (major !== null && minor !== null && fix !== null){
          return major * 1000000 + minor * 1000 + fix;
        } else {
          // Assume 3.1.0
          console.log("Gnocchi version unparsable: " + version);
          return 300010000;
        }
    }

    formatUnsupportedMultiValue(field) {
      return function(value, variable, formater){
        if (typeof value === 'string') {
          return value;
        } else if (value.length > 1) {
          throw {message: "Templating multi value in '" + field + "' is unsupported"};
        } else {
          return value[0];
        }
      };
    }
    formatLabelTemplate(value, variable, formater) {
      if (typeof value === 'string') {
        return value;
      } else {
        return value[0];
      }
    }

    formatQueryTemplate(value, variable, formater) {
      if (typeof value === 'string') {
        return value;
      } else {
        var values = _.map(value, (v: string) => {
            return '"' + v.replace('"', '\"') + '"';
        });
        return "[" + values.join(", ") + "]";
      }
    }

    isJsonQuery(query) {
        return query.trim()[0] === '{';
    }

    checkMandatoryFields(target) {
      var mandatory = [];
      switch (target.queryMode) {
        case "metric":
          if (!target.metric_id) {
            mandatory.push("Metric ID");
          }
          break;
        case "resource":
          if (!target.resource_id) {
            mandatory.push("Resource ID");
          }
          if (!target.metric_name) {
            mandatory.push("Metric regex");
          }
          break;
        case "resource_aggregation":
        case "resource_search":
          if (!target.resource_search) {
            mandatory.push("Query");
          }
          if (!target.metric_name) {
            mandatory.push("Metric regex");
          }
          break;
        default:
          break;
      }
      if (mandatory.length >= 1) {
        throw {message: mandatory.join(", ") + " must be filled"};
      }
    }

    sanitize_url(url) {
      if (url[url.length - 1] !== '/') {
        return url + '/';
      } else {
        return url;
      }
    }

    //////////////////////
    /// KEYSTONE STUFFS
    //////////////////////

    _gnocchi_request(additional_options) {
      var deferred = this.$q.defer();
      this._gnocchi_auth_request(deferred, () => {
        var options = {
          url: null,
          method: null,
          headers: null,
          withCredentials: this.withCredentials
        };
        angular.merge(options, additional_options);
        if (this.url){
          options.url = this.url + options.url;
        }
        if (!options.method) {
          options.method = 'GET';
        }
        if (!options.headers) {
          options.headers = this.default_headers;
        }
        return this.backendSrv.datasourceRequest(options).then((response) => {
          deferred.resolve(response.data);
        });
      }, true);
      return deferred.promise;
    }

    _gnocchi_auth_request(deferred, callback, retry) {
      if (this.keystone_endpoint !== null && this.url === null){
        this._keystone_auth_request(deferred, callback);
      } else {
        callback().then(undefined, (reason) => {
          if (reason.status === undefined){
            reason.message = "Gnocchi error: No response status code, is CORS correctly configured ? (detail: " + reason + ")";
            deferred.reject(reason);
          } else if (reason.status === 0){
            reason.message = "Gnocchi error: Connection failed";
            deferred.reject(reason);
          } else if (reason.status === 401) {
            if (this.keystone_endpoint !== null && retry){
              this._keystone_auth_request(deferred, callback);
            } else {
              deferred.reject({'message': "Gnocchi authentication failure"});
            }
          } else if (reason.data !== undefined && reason.data.message !== undefined) {
            if (reason.status >= 300 && reason.status < 500) {
              // Remove pecan generic message, replace <br> by \n, strip other html tag
              reason.data.message = reason.data.message.replace(/[^<]*<br \/><br \/>/gm, '');
              reason.data.message = reason.data.message.replace('<br />', '\n').replace(/<[^>]+>/gm, '').trim();
              deferred.reject(reason);
            }
          } else {
            deferred.reject(reason);
          }
        });
      }
    }

    _keystone_auth_request(deferred, callback) {
      var options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        url: this.keystone_endpoint + 'v3/auth/tokens',
        data: {
          "auth": {
            "identity": {
              "methods": ["password"],
              "password": {
                "user": {
                  "name": this.username,
                  "password": this.password,
                  "domain": { "id": this.domain  }
                }
              }
            },
            "scope": {
              "project": {
                "domain": { "id": this.domain },
                "name": this.project,
              }
            }
          }
        }
      };

      this.backendSrv.datasourceRequest(options).then((result) => {
        this.default_headers['X-Auth-Token'] = result.headers('X-Subject-Token');
        _.each(result.data['token']['catalog'], (service) => {
          if (service['type'] === 'metric') {
            _.each(service['endpoints'], (endpoint) => {
              if (endpoint['interface'] === 'public') {
                this.url = this.sanitize_url(endpoint['url']);
              }
            });
          }
        });
        if (this.url) {
          this._gnocchi_auth_request(deferred, callback, false);
        } else {
          deferred.reject({'message': "'metric' endpoint not found in Keystone catalog"});
        }
      }, (reason) => {
        var message;
        if (reason.status === 0){
          message = "Connection failed";
        } else {
          if (reason.status !== undefined) {
              message = '(' + reason.status + ' ' + reason.statusText + ') ';
              if (reason.data && reason.data.error) {
                message += ' ' + reason.data.error.message;
              }
          } else {
              message = 'No response status code, is CORS correctly configured ?';
          }
        }
        deferred.reject({'message': 'Keystone failure: ' + message});
      });
    }
}
