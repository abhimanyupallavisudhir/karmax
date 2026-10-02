# panagent runtime

This is the dependency-light `panagent` Python runtime used for conversation imports.
It is vendored from <https://github.com/abhimanyupallavisudhir/panagent> at version
0.2.0, upstream commit `2cee83a7091271006b56dee9bc66400e2ba5eeb6`, so local installs and the control-plane image behave identically without a
network-time package install. Update this directory from the upstream package; do
not maintain a second converter implementation in Krmax.
