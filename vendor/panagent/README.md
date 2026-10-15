# panagent runtime

This is the dependency-light `panagent` Python runtime used for conversation imports.
It is vendored from <https://github.com/abhimanyupallavisudhir/panagent> at version
0.3.0, upstream commit `6e9d971f33f4834841862da8469880f9cefbb88a`, so local installs and the control-plane image behave identically without a
network-time package install. Update this directory from the upstream package; do
not maintain a second converter implementation in Krmax.
