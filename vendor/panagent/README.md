# panagent runtime

This is the dependency-light `panagent` Python runtime used for conversation imports.
It is vendored from <https://github.com/abhimanyupallavisudhir/panagent> at version
0.2.0, upstream commit `af198f5fe7796d91313cfb6f32b765746be6da2e`, so local installs and the control-plane image behave identically without a
network-time package install. Update this directory from the upstream package; do
not maintain a second converter implementation in Krmax.
