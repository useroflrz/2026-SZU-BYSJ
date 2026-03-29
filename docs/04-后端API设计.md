# 后端API设计文档（预留）

说明：当前版本的项目以 **前端北斗格网渲染** 为核心，后端暂不纳入验收范围。本文件作为后续扩展的接口设计草案保留，内容可能与当前实现不完全一致。

## 1. API架构

### 1.1 RESTful API设计

- **基础URL**: `/api/v1`
- **认证方式**: JWT Token（Bearer Token）
- **数据格式**: JSON
- **错误处理**: 统一错误响应格式

### 1.2 WebSocket支持

- **连接地址**: `/ws/analysis`
- **用途**: 实时推送分析进度和结果
- **消息格式**: JSON

## 2. 区域管理API

### 2.1 获取区域列表

```
GET /api/v1/regions
```

**响应**:
```json
{
  "code": 200,
  "data": [
    {
      "id": "region_001",
      "name": "深圳市",
      "bounds": {
        "minX": 471865.98,
        "minY": 2476017.72,
        "maxX": 566258.98,
        "maxY": 2531700.31
      },
      "crs": "EPSG:4547",
      "dsmUrl": "/data/dsm/shenzhen.tif"
    }
  ]
}
```

### 2.2 创建自定义区域

```
POST /api/v1/regions
```

**请求体**:
```json
{
  "name": "自定义区域",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[...]]
  },
  "crs": "EPSG:4547"
}
```

### 2.3 上传区域边界文件

```
POST /api/v1/regions/upload
Content-Type: multipart/form-data
```

**参数**:
- `file`: GeoJSON/KML文件
- `name`: 区域名称

## 3. DSM数据API

### 3.1 获取DSM信息

```
GET /api/v1/dsm/info?region_id={region_id}
```

**响应**:
```json
{
  "code": 200,
  "data": {
    "url": "/data/dsm/region_001.tif",
    "extent": {
      "minX": 471865.98,
      "minY": 2476017.72,
      "maxX": 566258.98,
      "maxY": 2531700.31
    },
    "size": {
      "width": 5000,
      "height": 4000
    },
    "cellSize": {
      "x": 1.0,
      "y": 1.0
    },
    "crs": "EPSG:4547"
  }
}
```

### 3.2 采样DSM高程

```
POST /api/v1/dsm/sample
```

**请求体**:
```json
{
  "points": [
    {"x": 500000, "y": 2500000},
    {"x": 501000, "y": 2501000}
  ],
  "region_id": "region_001"
}
```

**响应**:
```json
{
  "code": 200,
  "data": [
    {"x": 500000, "y": 2500000, "z": 125.5},
    {"x": 501000, "y": 2501000, "z": 130.2}
  ]
}
```

## 4. 站点管理API

### 4.1 创建站点

```
POST /api/v1/stations
```

**请求体**:
```json
{
  "name": "基站001",
  "position": {
    "lon": 114.123,
    "lat": 22.456,
    "height": 150.0
  },
  "frequency": 1.4,
  "type": "base_station"
}
```

### 4.2 批量导入站点

```
POST /api/v1/stations/batch
Content-Type: multipart/form-data
```

**参数**:
- `file`: CSV/GeoJSON文件
- `format`: csv | geojson

**CSV格式**:
```csv
name,lon,lat,height,frequency
基站001,114.123,22.456,150.0,1.4
```

### 4.3 获取站点列表

```
GET /api/v1/stations?region_id={region_id}
```

### 4.4 删除站点

```
DELETE /api/v1/stations/{station_id}
```

## 5. 格网生成API

### 5.1 生成空域格网

```
POST /api/v1/grid/generate
```

**请求体**:
```json
{
  "region_id": "region_001",
  "config": {
    "dx": 50.0,
    "dy": 50.0,
    "dz": 50.0,
    "z_min": 100.0,
    "z_max": 250.0,
    "use_dsm_extent": true,
    "grid_type": "regular"  // regular | beidou
  },
  "bounds": {
    "minX": 471865.98,
    "minY": 2476017.72,
    "maxX": 566258.98,
    "maxY": 2531700.31
  }
}
```

**响应**:
```json
{
  "code": 200,
  "data": {
    "task_id": "task_123456",
    "status": "processing",
    "estimated_time": 30
  }
}
```

### 5.2 获取格网生成结果

```
GET /api/v1/grid/result/{task_id}
```

**响应**:
```json
{
  "code": 200,
  "data": {
    "status": "completed",
    "points": [
      {
        "x": 500000,
        "y": 2500000,
        "z": 225.5,
        "dsm_z": 125.5,
        "z_layer": 100.0,
        "z_abs": 225.5,
        "grid_x_id": 0,
        "grid_y_id": 0,
        "layer_id": 0
      }
    ],
    "statistics": {
      "total_points": 100000,
      "valid_points": 95000,
      "coverage_rate": 95.0
    },
    "download_url": "/api/v1/grid/download/{task_id}"
  }
}
```

### 5.3 下载格网数据

```
GET /api/v1/grid/download/{task_id}?format={format}
```

**参数**:
- `format`: geojson | csv | gpkg（默认geojson）

## 6. LOS分析API

### 6.1 启动LOS分析

```
POST /api/v1/analysis/los
```

**请求体**:
```json
{
  "grid_task_id": "task_123456",
  "station_ids": ["station_001", "station_002"],
  "config": {
    "frequency": 1.4,
    "consider_curvature": true,
    "path_loss_threshold": 130.0,
    "max_distance": 40000.0,
    "batch_size": 10000
  },
  "advanced": {
    "tx_height_field": "height",
    "rx_height_field": "z_abs",
    "fresnel_zone": true,
    "atmospheric_refraction": true
  }
}
```

**响应**:
```json
{
  "code": 200,
  "data": {
    "analysis_id": "analysis_789012",
    "status": "queued",
    "websocket_url": "/ws/analysis/analysis_789012"
  }
}
```

### 6.2 获取分析进度（WebSocket）

**连接**: `ws://host/ws/analysis/{analysis_id}`

**消息格式**:
```json
{
  "type": "progress",
  "data": {
    "progress": 45,
    "processed": 45000,
    "total": 100000,
    "visible_count": 32000,
    "elapsed_time": 120
  }
}
```

**完成消息**:
```json
{
  "type": "completed",
  "data": {
    "analysis_id": "analysis_789012",
    "result_url": "/api/v1/analysis/result/analysis_789012",
    "statistics": {
      "total_receivers": 100000,
      "visible_receivers": 32000,
      "visibility_rate": 32.0
    }
  }
}
```

### 6.3 获取分析结果

```
GET /api/v1/analysis/result/{analysis_id}
```

**响应**:
```json
{
  "code": 200,
  "data": {
    "analysis_id": "analysis_789012",
    "results": [
      {
        "point_id": "point_001",
        "x": 500000,
        "y": 2500000,
        "z": 225.5,
        "visible": true,
        "distance": 5000.0,
        "loss_db": 105.2,
        "closest_tx": "station_001",
        "curvature_m": 0.5
      }
    ],
    "statistics": {
      "total": 100000,
      "visible": 32000,
      "visibility_rate": 32.0
    }
  }
}
```

## 7. 报告生成API

### 7.1 生成分析报告

```
POST /api/v1/report/generate
```

**请求体**:
```json
{
  "analysis_id": "analysis_789012",
  "format": "pdf",  // pdf | html | excel
  "options": {
    "include_charts": true,
    "include_statistics": true,
    "include_heatmap": true
  }
}
```

**响应**:
```json
{
  "code": 200,
  "data": {
    "report_id": "report_345678",
    "download_url": "/api/v1/report/download/report_345678",
    "status": "generating"
  }
}
```

### 7.2 下载报告

```
GET /api/v1/report/download/{report_id}
```

## 8. 错误响应格式

```json
{
  "code": 400,
  "message": "参数验证失败",
  "errors": [
    {
      "field": "dx",
      "message": "格网宽度必须大于0.1米"
    }
  ]
}
```

**HTTP状态码**:
- `200`: 成功
- `400`: 请求参数错误
- `401`: 未授权
- `404`: 资源不存在
- `500`: 服务器内部错误

## 9. 异步任务处理

### 9.1 任务状态查询

```
GET /api/v1/tasks/{task_id}
```

**响应**:
```json
{
  "code": 200,
  "data": {
    "task_id": "task_123456",
    "type": "grid_generation",
    "status": "processing",  // queued | processing | completed | failed
    "progress": 45,
    "result": null,
    "error": null
  }
}
```

### 9.2 取消任务

```
POST /api/v1/tasks/{task_id}/cancel
```

