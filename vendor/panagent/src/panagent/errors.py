class PanagentError(Exception):
    """An actionable conversion error suitable for CLI display."""


class AcquisitionError(PanagentError):
    """A remote conversation could not be acquired."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class BrowserRequired(AcquisitionError):
    """The page is a challenge or renders its conversation only in a browser."""


class FormatError(PanagentError):
    """Input did not match the expected conversation format."""
