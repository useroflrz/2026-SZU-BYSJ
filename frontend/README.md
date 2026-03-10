# 前端服务 - 3D GIS 可视域分析系统

## 项目说明

基于 Vue 3 + Vite 的前端应用，提供 3D 地图可视化、用户交互界面等功能。

## 技术栈

- Vue 3.3+
- Vite 5.0+
- Pinia (状态管理)
- Vue Router (路由)
- Cesium (3D 地球引擎)
- Element Plus (UI 组件库)
- ECharts (图表可视化)

## 环境要求

- Node.js 16+ 或更高版本
- npm 或 yarn 或 pnpm

## 安装步骤

### 1. 安装依赖

```bash
# 进入前端目录
cd frontend

# 安装依赖
npm install
# 或使用 yarn
yarn install
# 或使用 pnpm
pnpm install
```

### 2. 开发模式运行

```bash
npm run dev
# 或
yarn dev
# 或
pnpm dev
```

访问 http://localhost:3000 查看应用

### 3. 构建生产版本

```bash
npm run build
# 或
yarn build
# 或
pnpm build
```

构建产物在 `dist/` 目录

### 4. 预览生产构建

```bash
npm run preview
# 或
yarn preview
# 或
pnpm preview
```

## 项目结构

```
frontend/
├── index.html           # HTML 入口
├── vite.config.js      # Vite 配置
├── package.json         # 项目配置和依赖
├── README.md           # 本文件
└── src/
    ├── main.js         # 应用入口
    ├── App.vue         # 根组件
    ├── style.css       # 全局样式
    ├── components/     # 组件（待创建）
    ├── views/          # 页面视图（待创建）
    ├── stores/         # Pinia 状态管理（待创建）
    ├── services/       # API 服务（待创建）
    └── utils/          # 工具函数（待创建）
```

## 开发说明

- 使用 Vite 作为构建工具，支持快速热重载
- API 代理已配置，开发时自动转发到后端 (http://localhost:8000)
- 支持 TypeScript（可选，待配置）

