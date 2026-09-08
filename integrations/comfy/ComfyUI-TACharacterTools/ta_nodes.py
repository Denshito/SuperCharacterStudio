"""ComfyUI 参考图工具：一个付费生成节点和一个完全本地的切分节点。

API Key 只从 ComfyUI 进程环境读取。工作流 JSON 可以安全分享，因为节点参数中
没有密钥；confirm_spend 默认关闭，且失败后不会自动重发付费请求。
"""

import base64
import binascii
import io
import json
import os

import numpy as np
import requests
import torch
from PIL import Image, UnidentifiedImageError


API_URL = "https://openrouter.ai/api/v1/images"
MODEL = "openai/gpt-5.4-image-2"
DEFAULT_PROMPT = (
    "根据参考图生成同一角色的标准三视图角色设定表。从左到右严格排列：正面、右侧面、背面。"
    "三个视图必须保持完全一致的角色身份、服装、发型、颜色、材质、身体比例和配饰。"
    "全身完整可见，双臂自然略微张开，双腿分开站立，镜头高度和角色尺寸一致。"
    "纯色浅灰背景，无文字、无边框、无透视角度、无额外人物。"
)


def _tensor_to_data_url(image):
    array = np.nan_to_num(image.detach().cpu().numpy(), nan=0.0, posinf=1.0, neginf=0.0)
    array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
    if array.ndim != 3 or array.shape[2] not in (1, 3, 4):
        raise RuntimeError("参考图必须是灰度、RGB 或 RGBA 图像。")
    if array.shape[2] == 1:
        array = np.repeat(array, 3, axis=2)
    mode = "RGBA" if array.shape[2] == 4 else "RGB"
    buffer = io.BytesIO()
    Image.fromarray(array, mode=mode).save(buffer, format="PNG")
    return f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode('ascii')}"


def _decode_generated_image(data, device, dtype):
    if not isinstance(data, dict) or not isinstance(data.get("b64_json"), str):
        raise RuntimeError("OpenRouter 响应中没有可用的图片数据。")
    media_type = data.get("media_type", "image/png")
    if media_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise RuntimeError(f"OpenRouter 返回了不支持的图片格式：{media_type}")
    try:
        raw = base64.b64decode(data["b64_json"], validate=True)
        with Image.open(io.BytesIO(raw)) as source:
            source.load()
            image = np.asarray(source.convert("RGB"), dtype=np.float32) / 255.0
    except (binascii.Error, UnidentifiedImageError, OSError, ValueError) as exc:
        raise RuntimeError("OpenRouter 返回的图片数据已损坏或无法解码。") from exc
    return torch.from_numpy(image.copy()).unsqueeze(0).to(device=device, dtype=dtype), media_type


def _api_error(status_code):
    messages = {
        400: "请求参数不被模型支持，请检查提示词和生成选项。",
        401: "OpenRouter API Key 缺失或无效。",
        402: "OpenRouter 账户余额不足。",
        403: "OpenRouter Key 已禁用、达到消费上限或访问被拒绝。",
        404: "模型名称无效，或当前没有可用的模型路由。",
        413: "参考图或请求体过大，请缩小输入图片后重试。",
        429: "OpenRouter 请求过于频繁，请稍后由你手动重试。",
        502: "上游图像生成失败；节点不会自动重试。",
    }
    return messages.get(status_code, f"OpenRouter 请求失败（HTTP {status_code}）。")


class TAOpenRouterTurnaround:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "reference_images": ("IMAGE",),
                "prompt": ("STRING", {"default": DEFAULT_PROMPT, "multiline": True}),
                "quality": (["low", "medium", "high", "auto"], {"default": "low"}),
                "aspect_ratio": (["21:9", "16:9", "3:2", "4:3", "1:1", "2:3", "3:4", "9:16", "auto"], {"default": "21:9"}),
                "background": (["opaque", "auto"], {"default": "opaque"}),
                "confirm_spend": ("BOOLEAN", {"default": False, "label_on": "已确认付费", "label_off": "未确认"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "FLOAT", "STRING")
    RETURN_NAMES = ("turnaround_sheet", "cost_usd", "request_info")
    FUNCTION = "generate"
    CATEGORY = "TA Character Tools"
    DESCRIPTION = "使用 OpenRouter GPT Image 2 根据参考图生成正面、侧面、背面三联图。"

    def generate(self, reference_images, prompt, quality, aspect_ratio, background, confirm_spend):
        # 必须先检查确认和 Key，再编码大图或创建 HTTP 请求，确保取消操作零费用。
        if not confirm_spend:
            raise RuntimeError("未执行付费请求：请检查参数后打开“已确认付费”。")
        api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("没有检测到 OPENROUTER_API_KEY，请从设置了该环境变量的终端启动 Comfy Desktop。")
        if not isinstance(prompt, str) or not prompt.strip():
            raise RuntimeError("提示词不能为空。")
        if reference_images.ndim != 4 or not 1 <= reference_images.shape[0] <= 16:
            raise RuntimeError("参考图数量必须为 1 到 16 张。")

        # Comfy IMAGE 是 BHWC、0..1 浮点张量；每一张图独立转为 PNG Data URL。
        payload = {
            "model": MODEL,
            "prompt": prompt.strip(),
            "n": 1,
            "quality": quality,
            "aspect_ratio": aspect_ratio,
            "background": background,
            "stream": False,
            "input_references": [
                {"type": "image_url", "image_url": {"url": _tensor_to_data_url(image)}}
                for image in reference_images
            ],
        }
        try:
            response = requests.post(
                API_URL,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
                timeout=(15, 300),
            )
        except requests.Timeout as exc:
            raise RuntimeError("OpenRouter 请求超时。结果状态可能未知，请先查看 OpenRouter Logs，再决定是否重试。") from exc
        except requests.RequestException as exc:
            raise RuntimeError("无法连接 OpenRouter，请检查网络后由你手动重试。") from exc

        if response.status_code < 200 or response.status_code >= 300:
            raise RuntimeError(_api_error(response.status_code))
        try:
            body = response.json()
        except requests.exceptions.JSONDecodeError as exc:
            raise RuntimeError("OpenRouter 返回了无法解析的响应。") from exc
        if not isinstance(body, dict) or not isinstance(body.get("data"), list) or not body["data"]:
            raise RuntimeError("OpenRouter 响应中没有生成图片。")

        image, media_type = _decode_generated_image(body["data"][0], reference_images.device, reference_images.dtype)
        usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
        raw_cost = usage.get("cost")
        cost = float(raw_cost) if isinstance(raw_cost, (int, float)) and not isinstance(raw_cost, bool) else -1.0
        request_id = response.headers.get("x-request-id") or body.get("id") or "未提供"
        cost_text = f"${cost:.4f}" if cost >= 0 else "未提供"
        summary = f"生成完成｜费用 {cost_text}｜请求 {request_id}"
        info = json.dumps({
            "model": MODEL,
            "request_id": request_id,
            "created": body.get("created"),
            "media_type": media_type,
            "cost_usd": None if cost < 0 else cost,
        }, ensure_ascii=False)
        return {"ui": {"text": [summary], "ta_bridge": [info]}, "result": (image, cost, info)}


class TASplitTurnaround:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "left_split": ("FLOAT", {"default": 0.333, "min": 0.05, "max": 0.90, "step": 0.001}),
            "right_split": ("FLOAT", {"default": 0.667, "min": 0.10, "max": 0.95, "step": 0.001}),
        }}

    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = ("front", "side", "back")
    FUNCTION = "split"
    CATEGORY = "TA Character Tools"
    DESCRIPTION = "按两个可调比例将三联图切分为正面、侧面和背面。"

    def split(self, image, left_split, right_split):
        if image.ndim != 4:
            raise RuntimeError("输入必须是 ComfyUI IMAGE。")
        if not 0.0 < left_split < right_split < 1.0:
            raise RuntimeError("分隔比例必须满足 0 < 左分隔线 < 右分隔线 < 1。")
        width = image.shape[2]
        left = round(width * left_split)
        right = round(width * right_split)
        if left < 1 or right <= left or right >= width:
            raise RuntimeError("当前分隔比例产生了空白区域，请调整分隔线。")
        return image[:, :, :left, :], image[:, :, left:right, :], image[:, :, right:, :]


NODE_CLASS_MAPPINGS = {"TAOpenRouterTurnaround": TAOpenRouterTurnaround, "TASplitTurnaround": TASplitTurnaround}
NODE_DISPLAY_NAME_MAPPINGS = {"TAOpenRouterTurnaround": "TA OpenRouter 三视图生成", "TASplitTurnaround": "TA 三视图切分"}
