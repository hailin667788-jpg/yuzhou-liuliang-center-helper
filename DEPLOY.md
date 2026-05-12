# 固定公网网址部署（无域名）

## 推荐：Render 免费版

1. 注册并登录 Render（可直接用 GitHub 登录）
2. 把本项目上传到 GitHub 仓库
3. 在 Render 点击 **New +** -> **Blueprint**
4. 选择你的仓库，Render 会自动识别 `render.yaml`
5. 部署完成后会得到固定网址，例如：
   `https://yuzhou-liuliang-center-helper.onrender.com`

## 环境变量（可选）

- `PORT`: 默认 3000（Render 会自动注入）
- `HOST`: 默认 `0.0.0.0`（已内置）

## 启动命令

项目默认启动命令：`npm run start`
