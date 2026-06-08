"""Tests for LLMEngine with mocked OpenAI client."""

import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest


class TestLLMEngineMocked:
    def test_extract_entities_mock(self):
        from engines.llm_engine import LLMEngine

        engine = LLMEngine()

        # Mock the _get_client method to return a mock AsyncOpenAI client
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = json.dumps({
            "entities": [
                {"type": "person", "name": "韩立", "aliases": [], "description": "主角", "metadata": {}}
            ]
        })
        mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

        engine._clients = {"http://test#test-model": mock_client}

        import asyncio
        result = asyncio.run(engine.extract_entities(
            "韩立是主角",
            {"base_url": "http://test", "model_name": "test-model"},
            max_tokens=100
        ))

        assert len(result) == 1
        assert result[0]["name"] == "韩立"
        assert result[0]["type"] == "person"

    def test_chat_mock(self):
        from engines.llm_engine import LLMEngine
        import json

        engine = LLMEngine()

        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "韩立修炼了长春功。"
        mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

        engine._clients = {"http://test#test-model": mock_client}

        import asyncio
        result = asyncio.run(engine.chat(
            [{"role": "user", "content": "韩立修炼了什么？"}],
            ["韩立修炼了长春功"],
            {"base_url": "http://test", "model_name": "test-model"}
        ))

        assert "长春功" in result


import json
