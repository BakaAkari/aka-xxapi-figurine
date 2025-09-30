# AI图片手办化接口

**请求方式：** GET

**接口地址：** https://v2.xxapi.cn/api/generateFigurineImage

**接口描述：** 免费API 提供AI图片手办化接口，只需上传一张图片，即可通过AI生成逼真的手办风格照片。支持高清输出、自然光影、细腻质感，适合二次元、游戏角色、模型爱好者使用，简单调用即可快速实现图片手办化效果。

## 请求参数

| 参数名 | 传递参数 | 传入位置 | 类型 | 参数说明 |
|--------|----------|----------|------|----------|
| style | 1|2|3|4 | query | 可选 | 传入不同的style，生成不同风格的手办
1：https://cdn.xxhzm.cn/api/ai/style1.png
2：https://cdn.xxhzm.cn/api/ai/style2.png
3：https://cdn.xxhzm.cn/api/ai/style3.png
4：https://cdn.xxhzm.cn/api/ai/style4.png |
| url | 图片直链 | query | 必传 | 传入图片直链 |
| key | string | query | 必传 | 请登录后前往控制面板，查询您的key |

## 返回示例

```json
{
    "code": 200,
    "msg": "数据请求成功",
    "data": "https://leo-online.fbcontent.cn/leo-gallery/19905da4938c584.png",
    "request_id": "1164a4facd0a2de3e6bb43c4"
}
```
