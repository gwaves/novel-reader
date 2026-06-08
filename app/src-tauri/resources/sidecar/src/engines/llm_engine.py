"""LLM Engine - using openai SDK for OpenAI-compatible APIs."""

import os
from typing import Any, Dict, List, Optional, AsyncIterator

import openai
from openai import AsyncOpenAI


class LLMEngine:
    def __init__(self):
        self._clients: Dict[str, AsyncOpenAI] = {}

    def _get_client(self, model_config: Dict[str, str]) -> AsyncOpenAI:
        """Get or create an AsyncOpenAI client for the given config."""
        cache_key = f"{model_config.get('base_url')}#{model_config.get('model_name')}"
        if cache_key not in self._clients:
            self._clients[cache_key] = AsyncOpenAI(
                base_url=model_config["base_url"],
                api_key=model_config.get("api_key") or os.environ.get("OPENAI_API_KEY", "dummy"),
                timeout=120.0,
            )
        return self._clients[cache_key]

    async def extract_entities(
        self,
        text: str,
        model_config: Dict[str, str],
        max_tokens: int = 4096,
    ) -> List[Dict[str, Any]]:
        """Extract entities (person, faction, item, skill, location) from text."""
        client = self._get_client(model_config)
        system_prompt = (
            "你是一个小说内容解析专家。请从以下文本中提取实体，"
            "返回严格的 JSON 数组。每个实体包含字段："
            "type (person/faction/item/skill/location), name, aliases (数组), "
            "description, metadata (对象)。"
        )

        response = await client.chat.completions.create(
            model=model_config["model_name"],
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"文本内容：\n{text}"},
            ],
            response_format={"type": "json_object"},
            max_tokens=max_tokens,
            temperature=0.2,
        )

        content = response.choices[0].message.content
        import json

        data = json.loads(content) if content else {}
        return data.get("entities", [])

    async def extract_relations(
        self,
        text: str,
        entities: List[Dict[str, Any]],
        model_config: Dict[str, str],
        max_tokens: int = 4096,
    ) -> List[Dict[str, Any]]:
        """Extract relations between given entities from text."""
        client = self._get_client(model_config)
        system_prompt = (
            "你是一个小说关系抽取专家。给定文本和实体列表，"
            "抽取实体之间的关系。返回 JSON 数组，每个关系包含："
            "from (实体name), to (实体name), type (关系类型), description。"
            "关系类型可选：master_of, disciple_of, spouse_of, sibling_of, "
            "parent_of, child_of, ally_of, enemy_of, friend_of, "
            "belongs_to, leader_of, founder_of, practices, creator_of, "
            "owns, uses, allied_with, hostile_to, related_to。"
        )

        entity_list = "\n".join(
            [f"- {e['type']}: {e['name']}" for e in entities]
        )
        response = await client.chat.completions.create(
            model=model_config["model_name"],
            messages=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": f"实体列表：\n{entity_list}\n\n文本内容：\n{text}",
                },
            ],
            response_format={"type": "json_object"},
            max_tokens=max_tokens,
            temperature=0.2,
        )

        content = response.choices[0].message.content
        import json

        data = json.loads(content) if content else {}
        return data.get("relations", [])

    async def chat(
        self,
        messages: List[Dict[str, str]],
        context: List[str],
        model_config: Dict[str, str],
        max_tokens: int = 4096,
    ) -> str:
        """Non-streaming chat with RAG context."""
        client = self._get_client(model_config)
        system_msg = (
            "你是一个小说阅读助手。请仅基于以下上下文回答问题，"
            "如果上下文不足以回答，请明确说明。"
        )
        if context:
            system_msg += "\n\n上下文：\n" + "\n---\n".join(context)

        all_messages = [{"role": "system", "content": system_msg}]
        all_messages.extend(messages)

        response = await client.chat.completions.create(
            model=model_config["model_name"],
            messages=all_messages,
            max_tokens=max_tokens,
            temperature=0.7,
        )
        return response.choices[0].message.content or ""

    async def chat_stream(
        self,
        messages: List[Dict[str, str]],
        context: List[str],
        model_config: Dict[str, str],
        max_tokens: int = 4096,
    ) -> AsyncIterator[str]:
        """Streaming chat with RAG context."""
        client = self._get_client(model_config)
        system_msg = (
            "你是一个小说阅读助手。请仅基于以下上下文回答问题。"
        )
        if context:
            system_msg += "\n\n上下文：\n" + "\n---\n".join(context)

        all_messages = [{"role": "system", "content": system_msg}]
        all_messages.extend(messages)

        stream = await client.chat.completions.create(
            model=model_config["model_name"],
            messages=all_messages,
            max_tokens=max_tokens,
            temperature=0.7,
            stream=True,
        )

        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
