# 3D GIS 可视域分析系统

基于 Vue + Cesium 和 FastAPI 的 3D GIS 数据可视化与分析工具，支持空域格网生成和 LOS 可视域分析。

## 项目结构

```
biyesheji/
├── frontend/              # 前端项目 (Vue 3 + Vite)
│   ├── src/               # 源代码
│   ├── package.json       # 前端依赖
│   └── README.md          # 前端说明
├── backend/               # 后端项目 (FastAPI)
│   ├── main.py            # 后端入口
│   ├── requirements.txt   # 后端依赖
│   └── README.md          # 后端说明
├── docs/                   # 技术文档
│   ├── 01-项目概述.md
│   ├── 02-技术架构.md
│   ├── 03-前端设计.md
│   ├── 04-后端API设计.md
│   ├── 05-功能模块设计.md
│   ├── 06-数据流程.md
│   ├── 07-部署方案.md
│   └── README.md
├── data/                   # 数据目录
├── environment.yml        # Conda 环境配置
└── README.md              # 本文件
```

## 快速开始

### 前置要求

- Python 3.9+
- Node.js 16+
- Conda (推荐)

### 1. 创建后端环境

```bash
# 使用 conda 创建虚拟环境
conda env create -f environment.yml

# 激活环境
conda activate gis3d-backend

# 进入后端目录并安装依赖
cd backend
pip install -r requirements.txt
```

### 2. 启动后端服务

```bash
# 在 backend 目录下
python main.py
# 或
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

后端服务将在 http://localhost:8000 启动

访问 http://localhost:8000/docs 查看 API 文档

### 3. 启动前端服务

```bash
# 新开一个终端，进入前端目录
cd frontend

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

前端服务将在 http://localhost:3000 启动

## 验证安装

### 后端 Hello World

访问 http://localhost:8000/ 应该看到：

```json
{
  "message": "Hello World from FastAPI!",
  "service": "3D GIS 可视域分析系统 - 后端API",
  "version": "1.0.0",
  "status": "running"
}
```

### 前端 Hello World

访问 http://localhost:3000 应该看到前端欢迎页面。

## 技术栈

### 前端
- Vue 3.3+ - 渐进式 JavaScript 框架
- Vite 5.0+ - 下一代前端构建工具
- Pinia - 状态管理
- Cesium - 3D 地球渲染引擎
- Element Plus - Vue 3 UI 组件库

### 后端
- FastAPI - 现代、快速的 Web 框架
- Uvicorn - ASGI 服务器
- GDAL - GIS 数据处理库
- NumPy - 数值计算

## 开发指南

### 后端开发

1. 激活 conda 环境：`conda activate gis3d-backend`
2. 进入后端目录：`cd backend`
3. 启动服务：`python main.py` (支持热重载)
4. 访问 API 文档：http://localhost:8000/docs

### 前端开发

1. 进入前端目录：`cd frontend`
2. 安装依赖：`npm install`
3. 启动开发服务器：`npm run dev`
4. 访问应用：http://localhost:3000

## 项目文档

详细的技术文档请查看 [docs/README.md](./docs/README.md)

- [项目概述](./docs/01-项目概述.md)
- [技术架构](./docs/02-技术架构.md)
- [前端设计](./docs/03-前端设计.md)
- [后端API设计](./docs/04-后端API设计.md)
- [功能模块设计](./docs/05-功能模块设计.md)
- [数据流程](./docs/06-数据流程.md)
- [部署方案](./docs/07-部署方案.md)

## 下一步

1. ✅ 项目结构创建完成
2. ✅ Hello World 示例运行成功
3. ⏳ 集成 Cesium 地图组件
4. ⏳ 实现区域选择功能
5. ⏳ 实现站点划设功能
6. ⏳ 实现格网生成功能
7. ⏳ 实现 LOS 分析功能

## 许可证

本项目为毕业设计项目。

## 联系方式

如有问题，请查看文档或联系项目团队。

