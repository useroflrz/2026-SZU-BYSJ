# 项目安装和启动指南

## 环境准备

### 1. 安装 Conda

如果还没有安装 Conda，请先安装：
- Miniconda: https://docs.conda.io/en/latest/miniconda.html
- 或 Anaconda: https://www.anaconda.com/products/distribution

### 2. 安装 Node.js

下载并安装 Node.js 16+：
- https://nodejs.org/

## 后端环境设置

### 步骤 1: 创建 Conda 虚拟环境

```bash
# 在项目根目录执行
conda env create -f environment.yml

# 激活环境
conda activate gis3d-backend
```

### 步骤 2: 安装后端依赖

```bash
# 进入后端目录
cd backend

# 安装 Python 依赖
pip install -r requirements.txt
```

### 步骤 3: 验证后端安装

```bash
# 运行后端服务
python main.py
```

如果看到类似以下输出，说明后端启动成功：

```
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
INFO:     Started reloader process
INFO:     Started server process
INFO:     Waiting for application startup.
INFO:     Application startup complete.
```

访问 http://localhost:8000/ 应该看到 Hello World 响应。

访问 http://localhost:8000/docs 可以查看 API 文档。

## 前端环境设置

### 步骤 1: 安装前端依赖

```bash
# 进入前端目录
cd frontend

# 安装 Node.js 依赖
npm install
```

### 步骤 2: 启动前端开发服务器

```bash
# 启动开发服务器
npm run dev
```

如果看到类似以下输出，说明前端启动成功：

```
  VITE v5.0.8  ready in 500 ms

  ➜  Local:   http://localhost:3000/
  ➜  Network: use --host to expose
```

访问 http://localhost:3000 应该看到前端 Hello World 页面。

## 验证 Hello World

### 后端验证

1. 打开浏览器访问: http://localhost:8000/
2. 应该看到 JSON 响应：
```json
{
  "message": "Hello World from FastAPI!",
  "service": "3D GIS 可视域分析系统 - 后端API",
  "version": "1.0.0",
  "status": "running"
}
```

3. 访问 API 文档: http://localhost:8000/docs

### 前端验证

1. 打开浏览器访问: http://localhost:3000/
2. 应该看到带有 "🎉 前端运行成功！" 的欢迎页面

## 常见问题

### 问题 1: Conda 命令不存在

**解决方案**: 确保 Conda 已正确安装并添加到系统 PATH 中。

### 问题 2: Python 版本不匹配

**解决方案**: 确保使用 Python 3.9 或更高版本。可以通过 `python --version` 检查。

### 问题 3: npm install 失败

**解决方案**: 
- 检查 Node.js 版本: `node --version` (需要 16+)
- 尝试清除缓存: `npm cache clean --force`
- 使用国内镜像: `npm install --registry=https://registry.npmmirror.com`

### 问题 4: 端口被占用

**解决方案**: 
- 后端默认端口 8000，可以在 `main.py` 中修改
- 前端默认端口 3000，可以在 `vite.config.js` 中修改

### 问题 5: CORS 错误

**解决方案**: 后端已配置 CORS，确保后端服务正在运行。

## 下一步

安装成功后，可以开始开发：

1. 查看 [项目文档](./docs/README.md) 了解系统架构
2. 查看 [前端设计](./docs/03-前端设计.md) 了解前端开发
3. 查看 [后端API设计](./docs/04-后端API设计.md) 了解后端开发

