/**
 * deploy.js
 *
 * AWS resource naming format that is compatible and is expected:
 *
 * Auto-Scaling Group:     <app name>-<environment>
 * Launch Configuration:   <app name>-<environment>@<app version>
 * AMI Name:               <app name>@<app version>
 * Key Pair:               <app name>
 * ELB:                    <app name>-<environment>                    (non-alpha-num chars removed)
 * Security Group:         <APP NAME>_<ENVIRONMENT>
 * IAM role:               <app name>_<environment>
 *
 */

var AWS = require('aws-sdk')
    , async = require('async');

// defaults
var AWS_REGION = 'us-east-1'
    , API_VERSIONS = {
        EC2: '2015-04-15',
        ELB: '2012-06-01',
        AS: '2011-01-01',
        IAM: '2010-05-08'
    }
    , BASE_SEC_GROUP_NAME = 'BASE'
    , DEVELOP_ENV_NAME = 'develop';

var ec2, elb, as, iam;
var options = {};

//add timestamps to each console function
//https://github.com/mpalmerlee/console-ten
var consoleTEN = require('console-ten');
consoleTEN.init(console, consoleTEN.LEVELS['INFO']);

var init = function(args) {
    options = {
        appName: args.appName,
        awsRegion: args.awsRegion || AWS_REGION,
        devEnvName: args.devEnvName || DEVELOP_ENV_NAME,
        baseSGname: args.baseSGname || BASE_SEC_GROUP_NAME,
        amiId: null,
        version: args.version,
        environment: args.environment,
        instanceType: args.instanceType,
        securityGroups: []
    };

    options.amiName = options.appName + '@' + options.version;
    options.lcName = options.appName + '-' + options.environment + '@' + options.version;
    options.agName = options.appName + '-' + options.environment;
    options.elbName = options.appName.replace(/_/g, '') + '-' + options.environment;
    options.userData = "#!/bin/bash\n\ninitctl emit launch-" + options.appName + " NODE_ENV=" + options.environment;

    // if deploying for dev environment, tag LC with a timestamp for uniqueness
    if (args.environment == options.devEnvName) {
        var now = new Date().getTime();
        options.lcName += '-' + now;
    }

    options.existingLC = false;
    options.priorAMIs = [];
    options.agData = {};

    ec2 = new AWS.EC2({region: options.awsRegion, apiVersion: API_VERSIONS.EC2});
    elb = new AWS.ELB({region: options.awsRegion, apiVersion: API_VERSIONS.ELB});
    as = new AWS.AutoScaling({region: options.awsRegion, apiVersion: API_VERSIONS.AS});
    iam = new AWS.IAM({region: options.awsRegion, apiVersion: API_VERSIONS.IAM});
};
exports.init = init;

// --- Resource Checks ---

var checkAMIstate = function(conf, callback) {
    var imageIdentifier = conf.name;
    var params, latestImage, stats, images, remainingImage = {};
    var result = {
        state: 'unknown',
        id: null,
        rest: [],
        desc: ""
    };

    params = { Filters: [{ Name: 'name', Values: [imageIdentifier]}]};
    if (!conf.exactMatch)
        params.Filters[0].Values[0] += '*';

    ec2.describeImages(params, function(err, data) {
        if (err)
            return callback(err);

        if (data.Images.length == 0) {
            result.desc = "getAMIstate: " + params.Filters[0].Values[0] + " not found in " + options.awsRegion;
            return callback(null, result);
        }

        images = data.Images.map(function(image) {
            image.CreationDateTimestamp = new Date(image.CreationDate).getTime();
            return image;
        });

        latestImage = images.sort(function(a,b) {
            return b.CreationDateTimestamp - a.CreationDateTimestamp;
        }).shift();

        // extract image and snapshot ids
        result.rest = images.map(function(image) {
            remainingImage = {id: image.ImageId, snapshotIds: [] };
            image.BlockDeviceMappings.forEach(function(blockDeviceMapping) {
                if (blockDeviceMapping.Ebs && blockDeviceMapping.Ebs.SnapshotId) {
                    remainingImage.snapshotIds.push(blockDeviceMapping.Ebs.SnapshotId);
                }
            });

            return remainingImage;
        });

        stats = "(id: " + latestImage.ImageId + ", state: " + latestImage.State + ", created: " + latestImage.CreationDate + ")";
        result.id = latestImage.ImageId;

        if (latestImage.State != 'available') {
            result.state = latestImage.State;
            result.desc = "getAMIstate: " + latestImage.Name + " is not available " + stats;

            return callback(null, result);
        }

        result.state = 'available';
        result.desc = "getAMIstate: found " + latestImage.Name + " " + stats;

        callback(null, result);
    });
};

var checkELB = function(callback) {
    var params = { LoadBalancerNames: [options.elbName]};

    elb.describeLoadBalancers(params, function(err, data) {
        if (err)
            return callback(err);

        if (data.LoadBalancerDescriptions.length == 0)
            return callback("checkELB: ELB " + options.elbName + " not found in " + options.awsRegion);

        console.log("checkELB: found ELB " + data.LoadBalancerDescriptions[0].DNSName + " with " +
            data.LoadBalancerDescriptions[0].Instances.length + " member instances");
        callback();
    });
};

var checkLC = function(callback) {
    var params = { LaunchConfigurationNames: [options.lcName]};

    as.describeLaunchConfigurations(params, function(err, data) {
        if (err)
            return callback(err);

        if (data.LaunchConfigurations.length > 0) {
            console.log("checkLC: found an existing launch configuration " + options.lcName + " in " + options.awsRegion);
            return callback(null, true);
        }

        callback(null, false);
    });
};

var checkAG = function(callback) {
    var params = { AutoScalingGroupNames: [options.agName]};

    as.describeAutoScalingGroups(params, function(err, data) {
        if (err)
            return callback(err);

        if (data.AutoScalingGroups.length == 0)
            return callback("checkAG: auto-scaling group " + options.agName + " not found in " + options.awsRegion);

        callback(null, data.AutoScalingGroups[0]);
    });
};

var checkSG = function(callback) {
    var appSecGroupFound = false;
    var appSecGroup = options.appName.toUpperCase() + '_' + options.environment.toUpperCase();
    var params = { Filters: [{ Name: 'group-name', Values: [appSecGroup, options.baseSGname]}]};

    ec2.describeSecurityGroups(params, function(err, data) {
        if (err)
            return callback(err);

        data.SecurityGroups.forEach(function(secGroup) {
            // check if the BASE group is present, and if so, include
            if (secGroup.GroupName == options.baseSGname || secGroup.GroupName == appSecGroup)
                options.securityGroups.push(secGroup.GroupId);

            if (secGroup.GroupName == appSecGroup)
                appSecGroupFound = true;
        });

        if (!appSecGroupFound)
            return callback("checkSG: security group " + appSecGroup + " not found in " + options.awsRegion);

        console.log("checkSG: found " + options.securityGroups.length + " security group(s) in " + options.awsRegion + ": ", options.securityGroups);
        callback();
    });
};

var checkKP = function(callback) {
    var params = { KeyNames: [options.appName] };

    ec2.describeKeyPairs(params, function(err, data) {
        if (err)
            return callback(err);

        if (data.KeyPairs.length == 0)
            return callback("checkKP: key pair " + options.appName + " not found in " + options.awsRegion);

        console.log("checkKP: found key pair " + options.appName + " in " + options.awsRegion);
        callback();
    });
};

var checkIP = function(callback) {
    var params = { RoleName: options.appName + '_' + options.environment};

    iam.listInstanceProfilesForRole(params, function(err, data) {
        if (err)
            return callback(err);

        if (data.InstanceProfiles.length == 0)
            return callback("checkIP: instance profile " + options.appName + " not found in " + options.awsRegion);

        console.log("checkIP: found instance profile " + options.appName + " in " + options.awsRegion);
        callback();
    });
};

var checkELBinstanceHealth = function(instanceId, callback) {
    var params = { LoadBalancerName: options.elbName, Instances: [{ InstanceId: instanceId }] };

    elb.describeInstanceHealth(params, function(err, data) {
        if (err)
            return callback(err);

        if (data.InstanceStates.length == 0)
            return callback(null, "InstanceNotRegistered");

        callback(null, data.InstanceStates[0].State);
    });
};

// -----------------------

// --- Deploy Actions ---

var createLC = function(callback) {
    var userData = new Buffer(options.userData).toString('base64'); // that's how AWS wants it
    var params = { LaunchConfigurationName: options.lcName
                    , ImageId: options.amiId
                    , KeyName: options.appName
                    , InstanceType: options.instanceType
                    , SecurityGroups: options.securityGroups
                    , IamInstanceProfile: options.appName + '_' + options.environment
                    , UserData: userData
    };

    as.createLaunchConfiguration(params, function(err, data) {
        if (err)
            return callback(err);

        console.log("createLC: created launch configuration " + options.lcName + " in " + options.awsRegion);
        callback();
    });
};

var deleteLC = function(lcName, callback) {
    var params = { LaunchConfigurationName: lcName };

    as.deleteLaunchConfiguration(params, function(err, data) {
        if (err)
            return callback(err);

        console.log("deleteLC: deleted old launch configuration: " + lcName + " in " + options.awsRegion);
        callback();
    });
};

var updateAG = function(params, callback) {
    as.updateAutoScalingGroup(params, function(err, data) {
        if (err)
            return callback(err);

        console.log("updateAG: updated auto-scaling group " + options.agName + " (lc: " + options.lcName +
            ", des: " + params.DesiredCapacity + ", max: " + params.MaxSize + ")");
        callback();
    });
};

var resumeAG = function(callback) {
    var params = { AutoScalingGroupName: options.agName };

    as.resumeProcesses(params, function(err, data) {
        if (err)
            return callback(err);

        console.log("resumeAG: resumed processes for " + options.agName);
        callback();
    });
};

var suspendAG = function(callback) {
    var params = { AutoScalingGroupName: options.agName };

    as.suspendProcesses(params, function(err, data) {
        if (err)
            return callback(err);

        console.log("suspendAG: suspended processes for " + options.agName);
        callback();
    });
};

var waitForNewInstance = function(callback) {
    var agResult = { Instances: [] };
    var newInstance;
    var elapsed = 0;
    var interval = 20 * 1000; // 20 sec
    var timeout = 10 * 60 * 1000; // 10 min

    async.doUntil(
        function(cb) {
            if (elapsed >= timeout)
                return cb("waitForNewInstance: timed out (" + elapsed + ") waiting for new instance in " + options.agName + " auto-scaling group");

            console.log("waitForNewInstance: waiting for new instance in " + options.agName + " auto-scaling group...");
            checkAG(function(err, data) {
                if (err)
                    return cb(err);

                agResult = data;
                setTimeout(cb, interval);
            });
        },
        function() {
            for (var i=0; i<agResult.Instances.length; i++) {
                if (agResult.Instances[i].LifecycleState  == 'InService' &&
                    agResult.Instances[i].HealthStatus == 'Healthy' &&
                    agResult.Instances[i].LaunchConfigurationName == options.lcName) {

                    newInstance = agResult.Instances[i].InstanceId;
                    options.agData = agResult; // update AG info as a precaution to keep state in sync

                    console.log("waitForNewInstance: new instance in auto-scaling group " + options.agName + ": " + agResult.Instances[i].InstanceId);
                    return true;
                }
            }

            elapsed += interval;
            return false;
        },
        function(err) {
            callback(err, newInstance);
        }
    );
};

var waitForELBhealthCheck = function(newInstanceId, callback) {
    var instanceState = "Undefined";
    var elapsed = 0;
    var interval = 10 * 1000; // 10 sec
    var timeout = 5 * 60 * 1000; // 5 min

    async.doUntil(
        function(cb) {
            if (elapsed >= timeout)
                return cb("waitForELBhealthCheck: timed out (" + elapsed + ") waiting for " + newInstanceId + " + to join ELB " + options.elbName + " (state: " + instanceState + ")");

            console.log("waitForELBhealthCheck: waiting for " + newInstanceId + " to join ELB " + options.elbName + " (state: " + instanceState + ")");
            checkELBinstanceHealth(newInstanceId, function(err, state) {
                if (err)
                    return cb(err);

                instanceState = state;
                setTimeout(cb, interval);
            });
        },
        function() {
            if (instanceState == "InService") {
                console.log("waitForELBhealthCheck: " + newInstanceId + " has joined ELB " +  options.elbName + " and is in service!");
                return true;
            }

            elapsed += interval;
            return false;
        },
        function(err) {
            callback(err);
        }
    );
};

var waitForAvailableAMI = function(conf, callback) {
    var amiResult = { state: 'unknown' };
    var elapsed = 0;
    var attempts = 0;
    var interval;
    var timeout = 5 * 60 * 1000; // 5 min

    async.doUntil(
        function(cb) {
            if (elapsed >= timeout)
                return cb("waitForAvailableAMI: timed out (" + elapsed + ") waiting for " + conf.name + " to become available (state: " + amiResult.state + ")");

            console.log("waitForAvailableAMI: waiting for AMI " + conf.name + " to become available (state: " + amiResult.state + ")");
            checkAMIstate(conf, function(err, result) {
                if (err)
                    return cb(err);

                amiResult = result;
                attempts++;
                interval = (Math.pow(2, attempts) - 1) * 500;   // exponential backoff

                setTimeout(cb, interval);
            });
        },
        function() {
            if (amiResult.state != 'pending')
                return true;

            elapsed += interval;
            return false;
        },
        function(err) {
            callback(err, amiResult);
        }
    );
};
exports.waitForAvailableAMI = waitForAvailableAMI;  // can be called independently

var terminateAGinstance = function(instanceId, callback) {
    var params = { InstanceId: instanceId, ShouldDecrementDesiredCapacity: false };

    as.terminateInstanceInAutoScalingGroup(params, function(err, data) {
        if (err)
            return callback(err);

        console.log("terminateAGinstance: terminated auto-scaling group " + options.agName + " member instance: " + instanceId);
        callback();
    });
};

var removeOldAGinstances = function(callback) {
    var oldInstances = options.agData.Instances.filter(function(instance) {
        return (instance.LaunchConfigurationName != options.lcName);
    }).map(function(instance) {
        return instance.InstanceId;
    });

    console.log("removeOldAGinstances: replacing old instances in " + options.agName + ": ", oldInstances);
    async.eachSeries(oldInstances, function(instanceId, cb) {
        terminateAGinstance(instanceId, cb);
    }, callback);
};

var deregisterImage = function(imageId, callback) {
    var params = { ImageId: imageId };

    ec2.deregisterImage(params, function(err, data) {
        if (err)
            return callback(err);

        console.log("deregisterImage: de-registered AMI " + imageId);
        callback();
    });
};

var deleteSnapshot = function(snapshotId, callback) {
    var params = { SnapshotId: snapshotId };

    ec2.deleteSnapshot(params, function(err, data) {
        if (err)
            return callback(err);

        console.log("deleteSnapshot: deleted snapshot: " + snapshotId);
        callback();
    });
};

// --------------

// --- Controllers ---

var deleteAMIs = function(callback) {
    var snapshotIds;
    var priorAMIids = options.priorAMIs.map(function(priorAMI) {
        return priorAMI.id;
    });

    console.log("deleteAMIs: deleting old AMIs: ", priorAMIids);
    async.series({
        deregisterImages: function(cb) {
            async.eachLimit(priorAMIids, 2, function(priorAMIid, cb2) {
                deregisterImage(priorAMIid, cb2);
            }, cb);
        },
        deleteSnapshots: function(cb) {
            snapshotIds = options.priorAMIs.map(function(priorAMI) {
                return priorAMI.snapshotIds;
            }).reduce(function(a,b) {
                return a.concat(b);
            });

            async.eachLimit(snapshotIds, 2, function(snapshotId, cb2) {
                deleteSnapshot(snapshotId, cb2);
            }, cb);
        }
    }, callback);
};

var cleanUp = function(callback) {
    async.series({
        deleteLC: function(cb) {
            if (options.priorLC) {
                deleteLC(options.priorLC, cb);
                return;
            }
            cb("deleteLC: missing prior launch configuration: " + options.priorLC);
        },
        deleteAMIs: function(cb) {
            if (options.priorAMIs.length == 0) {
                console.log("deleteAMIs: no old AMIs to delete");
                return cb();
            }

            deleteAMIs(cb);
        }
    }, callback);
};

// Invoke resource checks to make sure AWS environment is in order before we make changes
var resourceChecks = function(callback) {
    async.auto({
        waitForAvailableAMI: function(cb, res) {
            waitForAvailableAMI({ name: options.amiName, exactMatch: (options.environment != options.devEnvName) }, function(err, result) {
                if (err)
                    return cb(err);

                if (result.state != 'available')
                    return cb(result.desc);

                options.amiId = result.id;          // AMI id will be used during LC creation
                options.priorAMIs = result.rest;    // old AMI ids and snapshot ids to delete (dev env only)
                console.log(result.desc);
                cb();
            });
        },
        checkELB: function(cb, res) {
            checkELB(cb);
        },
        checkLC: ['checkAG', function(cb, res) {
            checkLC(function(err, result) {
                if (err)
                    return cb(err);

                options.existingLC = result;
                cb();
            });
        }],
        checkAG: function(cb, res) {
            checkAG(function(err, result) {
                if (err)
                    return cb(err);

                console.log("checkAG: found auto-scaling group " + options.agName +
                    " (lc: " + result.LaunchConfigurationName +
                    ",  des: " + result.DesiredCapacity +
                    ",  min: " + result.MinSize +
                    ",  max: " + result.MaxSize + ")");

                if (result.LaunchConfigurationName == options.lcName)
                    return cb("checkAG: launch configuration " + options.lcName + " is already assigned to auto-scaling group " + options.agName);

                options.agData = result;                                // used later for AG update
                options.priorLC = result.LaunchConfigurationName;       // keep a reference to old LC
                cb();
            });
        },
        checkSG: function(cb, res) {
            checkSG(cb);
        },
        checkKP: function(cb, res) {
            checkKP(cb);
        },
        checkIP: function(cb, res) {
            checkIP(cb);
        }
    }, callback);
};

// 1. create a new LC
// 2. update AG with the new LC
// 3. update (swap out) running instances
var deploy = function(callback) {
    var maxBump = (options.agData.DesiredCapacity == options.agData.MaxSize);
    var max = (maxBump) ? (options.agData.MaxSize + 1) : options.agData.MaxSize;
    var desired = options.agData.DesiredCapacity + 1;

    var newInstance;

    async.series({
        createLC: function(cb) {
            if (!options.existingLC)
                createLC(cb);
            else
                cb();
        },
        updateAndExpandAG: function(cb) {
            updateAG({ AutoScalingGroupName: options.agName,
                        LaunchConfigurationName: options.lcName,
                        MaxSize: max,
                        DesiredCapacity: desired }, cb);
        },
        resumeAG: function(cb, res) {
            resumeAG(cb);
        },
        waitForNewInstance: function(cb) {
            waitForNewInstance(function(err, result) {
                if (err)
                    return cb(err);

                newInstance = result;
                cb();
            });
        },
        waitForELBhealthCheck: function(cb) {
            waitForELBhealthCheck(newInstance, cb);
        },
        removeOldAGinstances: function(cb) {
            removeOldAGinstances(cb);
        },
        updateAndShrinkAG: function(cb) {
            desired--;
            max = (maxBump) ? (max - 1) : max;

            updateAG({ AutoScalingGroupName: options.agName,
                        LaunchConfigurationName: options.lcName,
                        MaxSize: max,
                        DesiredCapacity: desired }, cb);
        },
        cleanUp: function(cb) {
            if (options.environment == options.devEnvName) {
                cleanUp(cb);
                return;
            }

            cb();
        }
    }, callback);
};

var asDeploy = function(callback) {
    console.log(">>> DEPLOYING " + options.amiName + " <<<");

    async.series({
        suspendAG: function(cb) {
            suspendAG(cb);
        },
        resourceChecks: function (cb) {
            console.log(">>> Performing pre-deployment resource checks <<<");
            resourceChecks(cb);
        },
        deploy: function (cb) {
            console.log(">>> Deploying... <<<");
            deploy(cb);
        }
    }, function (err, res) {
        if (err)
            console.error(err);

        callback(err);
    });
};
exports.asDeploy = asDeploy;