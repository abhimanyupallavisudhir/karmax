class PanagentError(Exception):
    """An actionable conversion error suitable for CLI display."""


class AcquisitionError(PanagentError):
    """A remote conversation could not be acquired."""


class FormatError(PanagentError):
    """Input did not match the expected conversation format."""
