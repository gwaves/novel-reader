"""Tests for JSON-RPC Server."""

import asyncio
import json
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from server import JSONRPCServer


pytestmark = pytest.mark.asyncio


class TestHealth:
    async def test_health_check(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            socket_path = os.path.join(tmpdir, "test.sock")
            server = JSONRPCServer(socket_path)

            # Start server in background
            task = asyncio.create_task(server.start())
            await asyncio.sleep(0.5)

            try:
                reader, writer = await asyncio.open_unix_connection(socket_path)
                request = json.dumps({
                    "jsonrpc": "2.0",
                    "id": "test-1",
                    "method": "system.health",
                    "params": {}
                }) + "\n"
                writer.write(request.encode())
                await writer.drain()

                response_data = await reader.readline()
                response = json.loads(response_data.decode())

                assert response["jsonrpc"] == "2.0"
                assert response["id"] == "test-1"
                assert "result" in response
                assert response["result"]["status"] == "ok"

                writer.close()
                await writer.wait_closed()
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    @pytest.mark.asyncio
    async def test_parse_document(self):
        import tempfile as tmp
        with tmp.TemporaryDirectory() as tmpdir:
            socket_path = os.path.join(tmpdir, "test.sock")
            server = JSONRPCServer(socket_path)

            # Create a simple text file
            txt_path = os.path.join(tmpdir, "test.txt")
            with open(txt_path, 'w', encoding='utf-8') as f:
                f.write("第一章 测试\n这是测试内容。\n")

            task = asyncio.create_task(server.start())
            await asyncio.sleep(0.5)

            try:
                reader, writer = await asyncio.open_unix_connection(socket_path)
                request = json.dumps({
                    "jsonrpc": "2.0",
                    "id": "test-2",
                    "method": "parse.document",
                    "params": {"filePath": txt_path, "format": "txt"}
                }) + "\n"
                writer.write(request.encode())
                await writer.drain()

                response_data = await reader.readline()
                response = json.loads(response_data.decode())

                assert response["jsonrpc"] == "2.0"
                assert "result" in response
                assert "chapters" in response["result"]
                assert "paragraphs" in response["result"]

                writer.close()
                await writer.wait_closed()
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
