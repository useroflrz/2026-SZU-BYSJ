# visibility_analysis_projected_optimized.py
from qgis.core import (
    QgsProcessing,
    QgsProcessingAlgorithm,
    QgsProcessingParameterFeatureSource,
    QgsProcessingParameterRasterLayer,
    QgsProcessingParameterNumber,
    QgsProcessingParameterString,
    QgsProcessingParameterFeatureSink,
    QgsProcessingParameterField,
    QgsProcessingParameterBoolean,
    QgsField,
    QgsFeature,
    QgsPointXY,
    QgsFields,
    QgsWkbTypes,
    QgsProcessingException,
    QgsFeatureSink,
    QgsGeometry,
    QgsCoordinateReferenceSystem,
    QgsUnitTypes,
    NULL
)
from qgis.PyQt.QtCore import QVariant
import math
import numpy as np
import time


class VisibilityAnalysisToolOptimized(QgsProcessingAlgorithm):
    """
    可视域分析工具（投影坐标系版）- 优化版本
    按距离排序所有发射源，找到第一个可视即停止，不限制数量
    """

    INPUT_TRANSMITTERS = 'INPUT_TRANSMITTERS'
    TX_HEIGHT_FIELD = 'TX_HEIGHT_FIELD'
    INPUT_RECEIVERS = 'INPUT_RECEIVERS'
    RX_HEIGHT_FIELD = 'RX_HEIGHT_FIELD'
    INPUT_DSM = 'INPUT_DSM'
    FREQUENCY = 'FREQUENCY'
    OUTPUT_FIELD = 'OUTPUT_FIELD'
    OUTPUT_RECEIVERS = 'OUTPUT_RECEIVERS'
    CONSIDER_CURVATURE = 'CONSIDER_CURVATURE'
    BATCH_SIZE = 'BATCH_SIZE'

    def initAlgorithm(self, config=None):
        self.addParameter(
            QgsProcessingParameterFeatureSource(
                self.INPUT_TRANSMITTERS,
                '发射源点图层',
                [QgsProcessing.TypeVectorPoint]
            )
        )
        self.addParameter(
            QgsProcessingParameterField(
                self.TX_HEIGHT_FIELD,
                '发射端高度字段（绝对海拔，米）',
                parentLayerParameterName=self.INPUT_TRANSMITTERS,
                type=QgsProcessingParameterField.Numeric,
                optional=True
            )
        )
        self.addParameter(
            QgsProcessingParameterFeatureSource(
                self.INPUT_RECEIVERS,
                '接收端点图层',
                [QgsProcessing.TypeVectorPoint]
            )
        )
        self.addParameter(
            QgsProcessingParameterField(
                self.RX_HEIGHT_FIELD,
                '接收端高度字段（绝对海拔，米）',
                parentLayerParameterName=self.INPUT_RECEIVERS,
                type=QgsProcessingParameterField.Numeric,
                optional=True
            )
        )
        self.addParameter(
            QgsProcessingParameterRasterLayer(
                self.INPUT_DSM,
                '数字表面模型（DSM）',
                optional=False
            )
        )
        self.addParameter(
            QgsProcessingParameterNumber(
                self.FREQUENCY,
                '发射频段 (GHz)',
                type=QgsProcessingParameterNumber.Double,
                defaultValue=1.4,
                minValue=0.1,
                maxValue=100.0
            )
        )
        self.addParameter(
            QgsProcessingParameterString(
                self.OUTPUT_FIELD,
                '可视性字段名称',
                defaultValue='visible',
                optional=False
            )
        )
        self.addParameter(
            QgsProcessingParameterFeatureSink(
                self.OUTPUT_RECEIVERS,
                '输出接收端图层（含可视性结果）',
                QgsProcessing.TypeVectorPoint
            )
        )
        self.addParameter(
            QgsProcessingParameterBoolean(
                self.CONSIDER_CURVATURE,
                '是否考虑地球曲率',
                defaultValue=True
            )
        )
        self.addParameter(
            QgsProcessingParameterNumber(
                self.BATCH_SIZE,
                '批处理大小',
                type=QgsProcessingParameterNumber.Integer,
                defaultValue=10000,
                minValue=1000,
                maxValue=100000,
                optional=True
            )
        )

    def processAlgorithm(self, parameters, context, feedback):
        start_time = time.time()
        
        # 获取输入参数
        transmitter_source = self.parameterAsSource(parameters, self.INPUT_TRANSMITTERS, context)
        receiver_source = self.parameterAsSource(parameters, self.INPUT_RECEIVERS, context)
        dsm_layer = self.parameterAsRasterLayer(parameters, self.INPUT_DSM, context)
        frequency = self.parameterAsDouble(parameters, self.FREQUENCY, context)
        output_field = self.parameterAsString(parameters, self.OUTPUT_FIELD, context)
        tx_height_field = self.parameterAsString(parameters, self.TX_HEIGHT_FIELD, context)
        rx_height_field = self.parameterAsString(parameters, self.RX_HEIGHT_FIELD, context)
        consider_curvature = self.parameterAsBool(parameters, self.CONSIDER_CURVATURE, context)
        batch_size = self.parameterAsInt(parameters, self.BATCH_SIZE, context)

        # 验证输入
        if not transmitter_source or not receiver_source or not dsm_layer:
            raise QgsProcessingException("输入图层无效")

        # 检查坐标系
        crs = transmitter_source.sourceCrs()
        if crs.mapUnits() != QgsUnitTypes.DistanceMeters:
            raise QgsProcessingException("本工具仅支持以米为单位的投影坐标系")

        if receiver_source.sourceCrs() != crs:
            raise QgsProcessingException("接收端图层 CRS 与发射端不一致")
        if dsm_layer.crs() != crs:
            raise QgsProcessingException("DSM 图层 CRS 与点图层不一致")

        feedback.pushInfo(f"开始可视域分析（优化版）")
        feedback.pushInfo(f"接收端数量: {receiver_source.featureCount()}")
        feedback.pushInfo(f"发射端数量: {transmitter_source.featureCount()}")
        feedback.pushInfo(f"批处理大小: {batch_size}")

        # === 1. 提取发射端数据 ===
        feedback.pushInfo("步骤1: 提取发射端数据...")
        transmitters, tx_heights = self.extract_transmitters(
            transmitter_source, tx_height_field, feedback
        )
        tx_points = np.array([(p.x(), p.y()) for p in transmitters])
        tx_count = len(transmitters)
        feedback.pushInfo(f"有效发射端: {tx_count}个")

        if tx_count == 0:
            raise QgsProcessingException("未找到有效的发射端")

        # === 2. 准备DSM数据 ===
        feedback.pushInfo("步骤2: 准备DSM数据...")
        dsm_data = self.prepare_dsm_data(dsm_layer, feedback)
        if dsm_data is None:
            raise QgsProcessingException("无法读取DSM数据")

        # === 3. 创建输出图层（关键修复：避免字段冲突）===
        feedback.pushInfo("步骤3: 准备输出图层...")
        input_fields = receiver_source.fields()
        output_fields = QgsFields()

        # 定义结果字段，避免与输入图层同名字段冲突
        result_fields = {
            output_field: QVariant.Int,
            'distance': QVariant.Double,
            'loss_db': QVariant.Double,
            'closest_tx': QVariant.Int,
            'curvature_m': QVariant.Double
        }

        # 添加非结果字段（来自输入）
        for field in input_fields:
            if field.name() not in result_fields:
                output_fields.append(field)

        # 显式添加结果字段（确保类型正确）
        for field_name, field_type in result_fields.items():
            output_fields.append(QgsField(field_name, field_type))

        (sink, dest_id) = self.parameterAsSink(
            parameters,
            self.OUTPUT_RECEIVERS,
            context,
            output_fields,
            receiver_source.wkbType(),
            receiver_source.sourceCrs()
        )
        if sink is None:
            raise QgsProcessingException("无法创建输出图层")

        # === 4. 批量处理接收端 ===
        feedback.pushInfo("步骤4: 开始批量处理接收端...")
        all_features = list(receiver_source.getFeatures())
        total_features = len(all_features)
        
        rx_has_z = self._is_pointz(receiver_source.wkbType())
        rx_field_idx = -1
        if not rx_has_z and rx_height_field:
            rx_field_idx = receiver_source.fields().lookupField(rx_height_field)
        
        visible_count = 0
        processed_count = 0

        for batch_start in range(0, total_features, batch_size):
            if feedback.isCanceled():
                break
                
            batch_end = min(batch_start + batch_size, total_features)
            batch_features = all_features[batch_start:batch_end]
            
            feedback.pushInfo(f"处理批次 {batch_start//batch_size + 1}/{(total_features+batch_size-1)//batch_size} "
                           f"({batch_start}-{batch_end})")
            
            batch_results = self.process_batch(
                batch_features, tx_points, tx_heights, dsm_data, frequency,
                consider_curvature, rx_has_z, rx_field_idx, feedback
            )
            
            # 写入结果
            for feature, result in zip(batch_features, batch_results):
                if result is None:
                    continue
                    
                processed_count += 1
                visible, distance, loss, tx_idx, curvature = result
                
                new_feat = QgsFeature(output_fields)
                new_feat.setGeometry(feature.geometry())
                
                # 复制非结果字段
                for field in input_fields:
                    if field.name() not in result_fields:
                        new_feat[field.name()] = feature[field.name()]
                
                # 显式设置结果字段（确保类型）
                new_feat[output_field] = int(1 if visible else 0)
                new_feat['distance'] = float(distance if visible else 0.0)
                new_feat['loss_db'] = float(loss if visible else 0.0)
                new_feat['closest_tx'] = int(tx_idx if visible else -1)
                new_feat['curvature_m'] = float(curvature)
                
                sink.addFeature(new_feat, QgsFeatureSink.FastInsert)
                if visible:
                    visible_count += 1
            
            progress = int(100 * batch_end / total_features)
            feedback.setProgress(progress)
            feedback.pushInfo(f"  已处理: {batch_end}/{total_features} "
                           f"可视: {visible_count}/{processed_count} ({visible_count/max(processed_count,1)*100:.1f}%)")
        
        # === 5. 输出统计信息 ===
        elapsed_time = time.time() - start_time
        feedback.pushInfo("=" * 50)
        feedback.pushInfo("分析完成！")
        feedback.pushInfo(f"总用时: {elapsed_time:.1f}秒")
        feedback.pushInfo(f"总接收端: {total_features}")
        feedback.pushInfo(f"有效接收端: {processed_count}")
        feedback.pushInfo(f"可视接收端: {visible_count}")
        if processed_count > 0:
            feedback.pushInfo(f"可视比例: {visible_count/processed_count*100:.2f}%")
        feedback.pushInfo("=" * 50)
        
        return {self.OUTPUT_RECEIVERS: dest_id}

    def extract_transmitters(self, source, height_field, feedback):
        """提取发射端数据"""
        transmitters = []
        tx_heights = []
        
        tx_has_z = self._is_pointz(source.wkbType())
        tx_field_idx = -1
        if not tx_has_z and height_field:
            tx_field_idx = source.fields().lookupField(height_field)
        
        count = 0
        for feat in source.getFeatures():
            geom = feat.geometry()
            if not geom or geom.isEmpty():
                continue
                
            point = geom.asPoint()
            z = None
            
            if tx_has_z:
                z = geom.constGet().z()
            elif tx_field_idx >= 0:
                z_val = feat.attribute(tx_field_idx)
                if not self._is_null(z_val):
                    try:
                        z = float(z_val)
                    except (ValueError, TypeError):
                        continue
            else:
                continue
                
            if z is None or math.isnan(z):
                continue
                
            transmitters.append(QgsPointXY(point.x(), point.y()))
            tx_heights.append(z)
            count += 1
            
        return transmitters, tx_heights

    def process_batch(self, batch_features, tx_points, tx_heights, dsm_data, 
                     frequency, consider_curvature, rx_has_z, rx_field_idx, feedback):
        """批量处理一组接收端：按距离排序所有发射源，找到可视即停"""
        results = []
        max_distance = self.calculate_max_distance(frequency)
        
        for feature in batch_features:
            geom = feature.geometry()
            if not geom or geom.isEmpty():
                results.append(None)
                continue
                
            rx_point = geom.asPoint()
            rx_x, rx_y = rx_point.x(), rx_point.y()
            
            # 提取接收端高度
            rx_z = None
            if rx_has_z:
                rx_z = geom.constGet().z()
            elif rx_field_idx >= 0:
                z_val = feature.attribute(rx_field_idx)
                if not self._is_null(z_val):
                    try:
                        rx_z = float(z_val)
                    except (ValueError, TypeError):
                        results.append(None)
                        continue
            
            if rx_z is None or math.isnan(rx_z):
                results.append(None)
                continue
            
            # 计算到所有发射端的距离
            rx_coords = np.array([rx_x, rx_y])
            distances = np.sqrt(np.sum((tx_points - rx_coords) ** 2, axis=1))
            
            # 按距离排序索引
            sorted_indices = np.argsort(distances)
            
            found_visible = False
            best_result = (False, 0.0, 0.0, -1, 0.0)
            
            for idx in sorted_indices:
                distance = distances[idx]
                if distance > max_distance:
                    break  # 后续更远，可提前终止
                
                # 路径损耗过滤
                distance_km = distance / 1000.0
                path_loss = 20 * math.log10(distance_km) + 20 * math.log10(frequency) + 92.45
                if path_loss > 130:
                    continue
                
                # 视线检查
                tx_x, tx_y = tx_points[idx]
                tx_height = tx_heights[idx]
                
                is_los = self.check_line_of_sight_optimized(
                    dsm_data,
                    tx_x, tx_y, tx_height,
                    rx_x, rx_y, rx_z,
                    distance,
                    consider_curvature,
                    feedback
                )
                
                if is_los:
                    curvature = 0.0
                    if consider_curvature:
                        curvature = self.calculate_earth_curvature(distance)
                    best_result = (True, distance, path_loss, idx + 1, curvature)
                    found_visible = True
                    break  # 找到最近的可视发射源，立即停止
            
            results.append(best_result if found_visible else (False, 0.0, 0.0, -1, 0.0))
        
        return results

    def check_line_of_sight_optimized(self, dsm_data, tx_x, tx_y, tx_height,
                                     rx_x, rx_y, rx_height, distance,
                                     consider_curvature, feedback):
        """优化的视线检查函数（修复比例计算）"""
        if distance < 10:
            return True
            
        try:
            extent = dsm_data['extent']
            array = dsm_data['array']
            rows = dsm_data['rows']
            cols = dsm_data['cols']
            cell_size_x = dsm_data['cell_size_x']
            cell_size_y = dsm_data['cell_size_y']
            
            x0 = int(round((tx_x - extent.xMinimum()) / cell_size_x))
            y0 = int(round((extent.yMaximum() - tx_y) / cell_size_y))
            x1 = int(round((rx_x - extent.xMinimum()) / cell_size_x))
            y1 = int(round((extent.yMaximum() - rx_y) / cell_size_y))
            
            x0 = max(0, min(cols - 1, x0))
            y0 = max(0, min(rows - 1, y0))
            x1 = max(0, min(cols - 1, x1))
            y1 = max(0, min(rows - 1, y1))
            
            if x0 == x1 and y0 == y1:
                return True
            
            dx = abs(x1 - x0)
            dy = abs(y1 - y0)
            total_pixel_dist = math.sqrt(dx*dx + dy*dy)
            if total_pixel_dist == 0:
                return True
            
            sx = 1 if x0 < x1 else -1
            sy = 1 if y0 < y1 else -1
            err = dx - dy
            
            x, y = x0, y0
            height_diff = rx_height - tx_height
            
            while True:
                if not (x == x0 and y == y0):  # skip start point
                    if 0 <= x < cols and 0 <= y < rows:
                        terrain_h = array[y, x]
                        if not np.isnan(terrain_h):
                            curr_pixel_dist = math.sqrt((x - x0)**2 + (y - y0)**2)
                            ratio = curr_pixel_dist / total_pixel_dist
                            
                            line_h = tx_height + height_diff * ratio
                            
                            if consider_curvature:
                                current_geo_dist = distance * ratio
                                curvature = self.calculate_earth_curvature(current_geo_dist)
                                line_h -= curvature
                            
                            if terrain_h > line_h + 3.0:
                                return False
                
                if x == x1 and y == y1:
                    break
                
                e2 = 2 * err
                if e2 > -dy:
                    err -= dy
                    x += sx
                if e2 < dx:
                    err += dx
                    y += sy
            
            return True
            
        except Exception as e:
            feedback.pushDebugInfo(f"视线检查异常: {str(e)}")
            return False

    def prepare_dsm_data(self, dsm_layer, feedback):
        """准备DSM数据（简化版，兼容 QGIS 3.18+）"""
        try:
            provider = dsm_layer.dataProvider()
            if provider is None:
                return None

            extent = provider.extent()
            cols = provider.xSize()
            rows = provider.ySize()
            cell_size_x = (extent.xMaximum() - extent.xMinimum()) / cols
            cell_size_y = (extent.yMaximum() - extent.yMinimum()) / rows

            feedback.pushInfo(f"DSM: {cols}x{rows}, 网格: {cell_size_x:.2f}x{cell_size_y:.2f}")

            block = provider.block(1, extent, cols, rows)
            dsm_array = np.full((rows, cols), np.nan, dtype=np.float32)

            valid_count = 0
            for row in range(rows):
                for col in range(cols):
                    value = block.value(row, col)
                    if math.isnan(value):
                        continue
                    try:
                        float_val = float(value)
                        if -1000 < float_val < 10000:
                            dsm_array[row, col] = float_val
                            valid_count += 1
                    except (ValueError, TypeError):
                        continue

            feedback.pushInfo(f"DSM有效数据: {valid_count}/{rows*cols} ({valid_count/(rows*cols)*100:.1f}%)")

            return {
                'array': dsm_array,
                'extent': extent,
                'cols': cols,
                'rows': rows,
                'cell_size_x': cell_size_x,
                'cell_size_y': cell_size_y
            }

        except Exception as e:
            feedback.pushWarning(f"准备DSM数据失败: {str(e)}")
            return None

    def _is_pointz(self, wkb_type):
        return wkb_type in [QgsWkbTypes.PointZ, QgsWkbTypes.Point25D, 
                          QgsWkbTypes.PointZM, QgsWkbTypes.PointM]

    def _is_null(self, value):
        return value is None or value == NULL

    def calculate_earth_curvature(self, distance_m):
        earth_radius = 6371000
        effective_radius = earth_radius * 4 / 3
        return (distance_m ** 2) / (2 * effective_radius)

    def calculate_max_distance(self, frequency):
        if frequency < 1:
            return 80000
        elif frequency < 3:
            return 40000
        elif frequency < 6:
            return 20000
        elif frequency < 12:
            return 10000
        else:
            return 5000

    def name(self):
        return 'visibilityanalysisprojectedoptimized'

    def displayName(self):
        return '可视域分析（投影坐标系版-优化）'

    def group(self):
        return '自定义工具'

    def groupId(self):
        return 'customtools'

    def shortHelpString(self):
        return """
        <h3>可视域分析（投影坐标系版-优化）</h3>
        <p>按距离排序所有发射源，找到第一个可视即停止，确保准确性。</p>
        
        <p><b>优化特性：</b></p>
        <ul>
          <li>不限制发射源检查数量，保证结果准确</li>
          <li>按距离升序检查，找到可视即停，效率高</li>
          <li>批处理减少内存占用</li>
          <li>支持大规模数据（10万+接收点）</li>
        </ul>
        
        <p><b>要求：</b>所有图层必须使用相同的以米为单位的投影坐标系（如 EPSG:4547）。</p>
        """

    def createInstance(self):
        return VisibilityAnalysisToolOptimized()