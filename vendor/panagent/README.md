# panagent runtime

This is the dependency-light `panagent` Python runtime used for conversation imports.
It is vendored from <https://github.com/abhimanyupallavisudhir/panagent> at version
0.3.0, upstream commit `4c8f30c07f3e6ad1b28f85a793c95da82dfd200f`, so local installs and the control-plane image behave identically without a
network-time package install. Update this directory from the upstream package; do
not maintain a second converter implementation in Krmax.
