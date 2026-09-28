class PanagentError(Exception):
    """An actionable conversion error suitable for CLI display."""


class AcquisitionError(PanagentError):
    """A remote conversation could not be acquired."""


class BrowserRequired(AcquisitionError):
    """The page is a challenge or renders its conversation only in a browser."""


class FormatError(PanagentError):
    """Input did not match the expected conversation format."""
