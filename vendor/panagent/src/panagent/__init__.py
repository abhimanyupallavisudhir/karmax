"""Provider-neutral agent conversation conversion."""

from .model import SCHEMA, new_conversation, validate_conversation

__all__ = ["SCHEMA", "new_conversation", "validate_conversation"]
__version__ = "0.2.0"
