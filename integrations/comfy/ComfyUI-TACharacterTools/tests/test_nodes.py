import base64
import io
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ta_nodes


def png_base64():
    buffer = io.BytesIO()
    Image.new("RGB", (6, 3), (10, 20, 30)).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


class FakeResponse:
    status_code = 200
    headers = {"x-request-id": "req-test"}

    def json(self):
        return {"created": 123, "data": [{"b64_json": png_base64(), "media_type": "image/png"}], "usage": {"cost": 0.04}}


class NodeTests(unittest.TestCase):
    def test_split(self):
        image = torch.zeros((1, 2, 10, 3))
        front, side, back = ta_nodes.TASplitTurnaround().split(image, 0.2, 0.7)
        self.assertEqual([front.shape[2], side.shape[2], back.shape[2]], [2, 5, 3])

    def test_paid_request_returns_bridge_metadata(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-only-key"}), patch.object(ta_nodes.requests, "post", return_value=FakeResponse()):
            result = ta_nodes.TAOpenRouterTurnaround().generate(torch.zeros((1, 4, 5, 3)), "turnaround", "low", "21:9", "opaque", True)
        self.assertEqual(result["result"][1], 0.04)
        self.assertIn("req-test", result["ui"]["ta_bridge"][0])

    def test_unconfirmed_request_never_calls_network(self):
        with patch.object(ta_nodes.requests, "post") as post:
            with self.assertRaisesRegex(RuntimeError, "未执行付费请求"):
                ta_nodes.TAOpenRouterTurnaround().generate(torch.zeros((1, 2, 2, 3)), "turnaround", "low", "21:9", "opaque", False)
        post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
