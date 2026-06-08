#!/usr/bin/env python3
"""
Novel AI Engine - Python Sidecar
JSON-RPC over Unix Domain Socket
"""

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any, Dict

from engines.parse_engine import ParseEngine
from engines.embed_engine import EmbedEngine
from engines.llm_engine import LLMEngine
from engines.rank_engine import RankEngine


class JSONRPCServer:
    def __init__(self, socket_path: str):
        self.socket_path = socket_path
        self.parse_engine = ParseEngine()
        self.embed_engine = EmbedEngine()
        self.llm_engine = LLMEngine()
        self.rank_engine = RankEngine()
        self.start_time = 0

        self.methods = {
            "parse.document": self.handle_parse_document,
            "parse.chapters": self.handle_parse_chapters,
            "embed.texts": self.handle_embed_texts,
            "embed.query": self.handle_embed_query,
            "llm.extractEntities": self.handle_extract_entities,
            "llm.extractRelations": self.handle_extract_relations,
            "llm.chat": self.handle_chat,
            "llm.chatStream": self.handle_chat_stream,
            "rank.bm25": self.handle_rank_bm25,
            "system.health": self.handle_health,
            "system.loadModel": self.handle_load_model,
        }

    async def start(self):
        self.start_time = asyncio.get_event_loop().time()
        if os.path.exists(self.socket_path):
            os.remove(self.socket_path)
        server = await asyncio.start_unix_server(
            self._handle_client, path=self.socket_path
        )
        os.chmod(self.socket_path, 0o600)
        print(f"Sidecar listening on {self.socket_path}", flush=True)
        async with server:
            await server.serve_forever()

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ):
        while True:
            try:
                line = await reader.readline()
                if not line:
                    break
                request = json.loads(line.decode("utf-8"))
                response = await self._process_request(request)
                writer.write(json.dumps(response).encode("utf-8") + b"\n")
                await writer.drain()
            except Exception as e:
                print(f"Client handler error: {e}", flush=True)
                break
        writer.close()

    async def _process_request(self, request: Dict[str, Any]) -> Dict[str, Any]:
        req_id = request.get("id", str(uuid.uuid4()))
        method = request.get("method", "")
        params = request.get("params", {})

        handler = self.methods.get(method)
        if not handler:
            return self._error(req_id, -32601, f"Method not found: {method}")

        try:
            result = await handler(params)
            return {"jsonrpc": "2.0", "id": req_id, "result": result}
        except Exception as e:
            return self._error(req_id, -32603, str(e))

    def _error(self, req_id: str, code: int, message: str) -> Dict[str, Any]:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}

    # ==================== Handlers ====================

    async def handle_parse_document(self, params: Dict[str, Any]) -> Dict[str, Any]:
        file_path = params["filePath"]
        file_format = params.get("format", Path(file_path).suffix.lstrip(".").lower())
        result = self.parse_engine.parse_document(file_path, file_format)
        return result

    async def handle_parse_chapters(self, params: Dict[str, Any]) -> Dict[str, Any]:
        # For now, same as document parse but only return chapters
        file_path = params.get("filePath", "")
        file_format = params.get("format", "txt")
        result = self.parse_engine.parse_document(file_path, file_format)
        return {"chapters": result.get("chapters", [])}

    async def handle_embed_texts(self, params: Dict[str, Any]) -> Dict[str, Any]:
        texts = params["texts"]
        batch_size = params.get("batchSize", 32)
        if not self.embed_engine.is_loaded():
            raise RuntimeError("Embedding model not loaded")
        return self.embed_engine.embed_texts(texts, batch_size)

    async def handle_embed_query(self, params: Dict[str, Any]) -> Dict[str, Any]:
        text = params["text"]
        if not self.embed_engine.is_loaded():
            raise RuntimeError("Embedding model not loaded")
        return self.embed_engine.embed_query(text)

    async def handle_extract_entities(self, params: Dict[str, Any]) -> Dict[str, Any]:
        text = params["text"]
        model_config = params["modelConfig"]
        max_tokens = params.get("maxTokens", 4096)
        entities = await self.llm_engine.extract_entities(text, model_config, max_tokens)
        return {"entities": entities}

    async def handle_extract_relations(self, params: Dict[str, Any]) -> Dict[str, Any]:
        text = params["text"]
        entities = params["entities"]
        model_config = params["modelConfig"]
        max_tokens = params.get("maxTokens", 4096)
        relations = await self.llm_engine.extract_relations(text, entities, model_config, max_tokens)
        return {"relations": relations}

    async def handle_chat(self, params: Dict[str, Any]) -> Dict[str, Any]:
        messages = params["messages"]
        context = params.get("context", [])
        model_config = params["modelConfig"]
        content = await self.llm_engine.chat(messages, context, model_config)
        return {"content": content, "citations": []}

    async def handle_chat_stream(self, params: Dict[str, Any]) -> Dict[str, Any]:
        # Streaming is handled by opening a separate connection
        # This returns a stream ID to identify the stream
        return {"streamId": str(uuid.uuid4())}

    async def handle_rank_bm25(self, params: Dict[str, Any]) -> Dict[str, Any]:
        query = params["query"]
        documents = params["documents"]
        top_k = params.get("topK", 5)
        results = self.rank_engine.bm25_rank(query, documents, top_k)
        return {"results": results}

    async def handle_health(self, params: Dict[str, Any]) -> Dict[str, Any]:
        loop = asyncio.get_event_loop()
        uptime = loop.time() - self.start_time if hasattr(self, "start_time") else 0
        models_loaded = []
        if self.embed_engine.is_loaded():
            models_loaded.append("bge-m3-onnx")
        return {
            "status": "ok",
            "version": "0.1.0",
            "modelsLoaded": models_loaded,
            "uptimeSeconds": int(uptime),
        }

    async def handle_load_model(self, params: Dict[str, Any]) -> Dict[str, Any]:
        model_path = params["modelPath"]
        model_type = params.get("modelType", "embedding")
        if model_type == "embedding":
            success = self.embed_engine.load_model(model_path)
            return {"status": "loaded" if success else "failed"}
        return {"status": "unknown_model_type"}


def main():
    socket_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/novel-reader-sidecar.sock"
    server = JSONRPCServer(socket_path)
    asyncio.run(server.start())


if __name__ == "__main__":
    main()
