'use strict';

// The webcam controls are attached to MeshCentral's existing desktop view.
// Keep the plugin hook so the package loads through the supported plugin API.
module.exports.mcawebcam = function (parent) {
    return {
        parent: parent,
        exports: ['onDeviceRefreshEnd'],
        onDeviceRefreshEnd: function () { }
    };
};
