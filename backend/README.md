# 后端服务 - 3D GIS 可视域分析系统

## 项目说明

基于 FastAPI 的后端 API 服务，提供 GIS 数据处理、空域格网生成、LOS 可视域分析等功能。

## 技术栈

- Python 3.9+
- FastAPI 0.104+
- Uvicorn (ASGI 服务器)
- GDAL (GIS 数据处理)
- NumPy, GeoPandas (数据处理)

## 环境要求

- Python 3.9 或更高版本
- Conda (推荐用于管理虚拟环境)

## 安装步骤

### 1. 创建 Conda 虚拟环境

```bash
# 进入后端目录
cd backend

# 创建 conda 环境
conda create -n gis3d-backend python=3.9 -y

# 激活环境
conda activate gis3d-backend
```

### 2. 安装依赖

```bash
# 安装 Python 包
pip install -r requirements.txt

# 安装 GDAL（Windows 推荐二选一）
#
# 方案 A（最推荐）：conda-forge 安装（自动处理 gdal/proj/geos 依赖）
# conda install -c conda-forge -y gdal
#
# 方案 B（离线/已下载 SDK）：使用仓库根目录下的 E:/biyesheji/gdal
# 注意：该 SDK 的 Python 绑定为 cp310（Python 3.10），请用 Python=3.10 创建环境：
# conda create -n gis3d-backend python=3.10 -y
# conda activate gis3d-backend
# pip install -r requirements.txt
# 然后在“同一个终端”执行（会设置 PATH/GDAL_DATA/PROJ_LIB/PYTHONPATH）：
# E:\biyesheji\gdal\SDKShell.bat setenv
#
# 验证是否成功（看到版本号即 OK）：
# python -c "from osgeo import gdal; print('GDAL', gdal.VersionInfo())"
```

### 3. 运行服务

```bash
# 方式1: 使用 uvicorn 命令
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# 方式2: 直接运行 main.py
python main.py
```

### 4. 访问 API

- API 文档: http://localhost:8000/docs
- 健康检查: http://localhost:8000/api/v1/health
- Hello World: http://localhost:8000/

## 项目结构

```
backend/
├── main.py              # FastAPI 应用入口
├── requirements.txt     # Python 依赖
├── README.md            # 本文件
└── app/                 # 应用模块（待创建）
    ├── api/             # API 路由
    ├── core/            # 核心业务逻辑
    ├── models/          # 数据模型
    └── utils/           # 工具函数
```

## 开发说明

- 使用 FastAPI 的自动文档功能查看 API 接口
- 支持热重载（--reload 参数）
- CORS 已配置，允许跨域请求

