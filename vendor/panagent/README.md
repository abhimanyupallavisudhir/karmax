# panagent runtime

This is the dependency-light `panagent` Python runtime used for conversation imports.
It is vendored from <https://github.com/abhimanyupallavisudhir/panagent> at version
0.3.0, upstream commit `459177ff7536dff01d8ee38fa8393ead61ff1976`, so local installs and the control-plane image behave identically without a
network-time package install. Update this directory from the upstream package; do
not maintain a second converter implementation in Krmax.
