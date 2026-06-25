"""Helpers for provider-normalized tool/function-call schemas (OpenAI tool format).

LiteLLM accepts OpenAI-style tool definitions and normalizes them across providers, so
the rest of the code defines tools once in this shape.
"""


def tool_schema(name: str, description: str, parameters: dict) -> dict:
    """Build one OpenAI-style tool definition.

    `parameters` is a JSON-Schema object describing the tool's arguments.
    """
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        },
    }
