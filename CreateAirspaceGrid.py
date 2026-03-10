# -*- coding: utf-8 -*-
"""
QGIS Processing Algorithm: 创建带DSM高程的空域格网中心点
Author: Assistant
Date: 2026-01-07

功能：
- 支持手动输入范围 或 自动使用DSM边界
- z_abs = DSM地面高程 + 相对层高
- 自动跳过NoData区域
- 输出PointZ几何 + 完整属性字段
- 增加格网ID便于后续分析
"""

from qgis.PyQt.QtCore import QCoreApplication, QVariant
from qgis.core import (
    QgsProcessing,
    QgsProcessingAlgorithm,
    QgsProcessingParameterNumber,
    QgsProcessingParameterRasterLayer,
    QgsProcessingParameterFeatureSink,
    QgsProcessingParameterBoolean,
    QgsProcessingParameterDefinition,  
    QgsFeature,
    QgsGeometry,
    QgsPointXY,
    QgsFields,
    QgsField,
    QgsWkbTypes,
    QgsRaster,
    QgsProject,
    QgsRectangle,
    QgsFeatureSink,
    QgsProcessingException
)
import numpy as np


class CreateAirspaceGridWithDSM(QgsProcessingAlgorithm):

    X_MIN = 'X_MIN'
    X_MAX = 'X_MAX'
    Y_MIN = 'Y_MIN'
    Y_MAX = 'Y_MAX'
    Z_MIN = 'Z_MIN'
    Z_MAX = 'Z_MAX'
    DZ = 'DZ'
    DX = 'DX'
    DY = 'DY'
    DSM_LAYER = 'DSM_LAYER'
    USE_DSM_EXTENT = 'USE_DSM_EXTENT'
    OUTPUT = 'OUTPUT'

    def tr(self, string):
        return QCoreApplication.translate('Processing', string)

    def createInstance(self):
        return CreateAirspaceGridWithDSM()

    def name(self):
        return 'createairspacegridwithdsm'

    def displayName(self):
        return self.tr('创建空域格网中心点（含DSM高程）')

    def group(self):
        return self.tr('自定义工具')

    def groupId(self):
        return 'customtools'

    def shortHelpString(self):
        return self.tr(
            "在指定范围和高度层内创建空域格网中心点，并叠加DSM地形高程。\n"
            "z_abs = DSM地面高程 + 相对层高\n"
            "自动跳过DSM NoData区域。\n"
            "可选择自动使用DSM图层边界。"
        )

    def initAlgorithm(self, config=None):
        # ========== 自动使用DSM边界开关 ==========
        self.addParameter(
            QgsProcessingParameterBoolean(
                self.USE_DSM_EXTENT,
                self.tr('自动使用DSM图层边界'),
                defaultValue=True,
                optional=False
            )
        )

        # ========== XY范围参数（高级参数） ==========
        for param, name, default in [
            (self.X_MIN, 'X最小值', 471865.9823),
            (self.X_MAX, 'X最大值', 566258.9799),
            (self.Y_MIN, 'Y最小值', 2476017.7218),
            (self.Y_MAX, 'Y最大值', 2531700.3058),
        ]:
            param_obj = QgsProcessingParameterNumber(
                param,
                self.tr(name),
                type=QgsProcessingParameterNumber.Double,
                defaultValue=default
            )
            param_obj.setFlags(param_obj.flags() | QgsProcessingParameterDefinition.FlagAdvanced)
            self.addParameter(param_obj)

        # ========== 高度与格网参数 ==========
        for param, name, default in [
            (self.Z_MIN, '最低相对高度（米）', 100.0),
            (self.Z_MAX, '最高相对高度（米）', 250.0),
            (self.DZ,   '层高间隔（米）', 50.0),
            (self.DX,   '格网宽度（米）', 50.0),
            (self.DY,   '格网高度（米）', 50.0),
        ]:
            self.addParameter(QgsProcessingParameterNumber(
                param,
                self.tr(name),
                type=QgsProcessingParameterNumber.Double,
                defaultValue=default,
                minValue=0.1
            ))

        # ========== DSM输入 ==========
        self.addParameter(
            QgsProcessingParameterRasterLayer(
                self.DSM_LAYER,
                self.tr('DSM栅格图层'),
                optional=False
            )
        )

        # ========== 输出 ==========
        self.addParameter(
            QgsProcessingParameterFeatureSink(
                self.OUTPUT,
                self.tr('输出点图层'),
                type=QgsProcessing.TypeVectorPoint
            )
        )

    def processAlgorithm(self, parameters, context, feedback):
        # --- 读取参数 ---
        use_dsm_extent = self.parameterAsBoolean(parameters, self.USE_DSM_EXTENT, context)
        z_min = self.parameterAsDouble(parameters, self.Z_MIN, context)
        z_max = self.parameterAsDouble(parameters, self.Z_MAX, context)
        dz = self.parameterAsDouble(parameters, self.DZ, context)
        dx = self.parameterAsDouble(parameters, self.DX, context)
        dy = self.parameterAsDouble(parameters, self.DY, context)

        # --- 获取DSM图层 ---
        dsm_layer = self.parameterAsRasterLayer(parameters, self.DSM_LAYER, context)
        if dsm_layer is None:
            raise QgsProcessingException("DSM图层无效")

        dsm_provider = dsm_layer.dataProvider()
        if not dsm_provider:
            raise QgsProcessingException("无法获取DSM数据提供者")

        # --- 确定计算范围 ---
        if use_dsm_extent:
            dsm_extent = dsm_layer.extent()
            x_min = dsm_extent.xMinimum()
            x_max = dsm_extent.xMaximum()
            y_min = dsm_extent.yMinimum()
            y_max = dsm_extent.yMaximum()
            feedback.pushInfo(f"使用DSM自动边界: X({x_min:.2f}, {x_max:.2f}), Y({y_min:.2f}, {y_max:.2f})")
        else:
            x_min = self.parameterAsDouble(parameters, self.X_MIN, context)
            x_max = self.parameterAsDouble(parameters, self.X_MAX, context)
            y_min = self.parameterAsDouble(parameters, self.Y_MIN, context)
            y_max = self.parameterAsDouble(parameters, self.Y_MAX, context)
            
            if x_min >= x_max or y_min >= y_max:
                raise QgsProcessingException("X/Y范围无效：最小值必须小于最大值")

        # --- 范围验证 ---
        if x_max - x_min < dx or y_max - y_min < dy:
            raise QgsProcessingException(f"范围太小：宽度({x_max-x_min:.1f}m)需大于格网宽度({dx}m)")

        # --- 计算格网参数 ---
        z_levels = np.arange(z_min, z_max + dz/2, dz)
        x_coords = np.arange(x_min + dx/2, x_max, dx)
        y_coords = np.arange(y_min + dy/2, y_max, dy)

        total_planar = len(x_coords) * len(y_coords)
        total_expected = total_planar * len(z_levels)
        
        feedback.pushInfo(f"区域范围: {x_max-x_min:.1f}m × {y_max-y_min:.1f}m")
        feedback.pushInfo(f"格网密度: {len(x_coords)}列 × {len(y_coords)}行")
        feedback.pushInfo(f"计划生成: {len(z_levels)}层 × {total_planar:,}点 = {total_expected:,}点")

        # 💡 内存安全提示（关键修正：移除dest_id引用）
        if total_expected > 1_000_000:
            feedback.pushWarning(f"⚠️ 将生成 {total_expected:,} 个点")
            feedback.pushInfo("💡 建议：输出到文件（如GeoPackage），避免临时图层内存溢出")

        # --- 定义输出字段 ---
        fields = QgsFields()
        fields.append(QgsField('x', QVariant.Double, '', 15, 3))
        fields.append(QgsField('y', QVariant.Double, '', 15, 3))
        fields.append(QgsField('dsm_z', QVariant.Double, '', 15, 3))
        fields.append(QgsField('z_layer', QVariant.Double, '', 6, 1))
        fields.append(QgsField('z_abs', QVariant.Double, '', 15, 3))
        fields.append(QgsField('grid_x_id', QVariant.Int, '', 5, 0))  # 格网列ID
        fields.append(QgsField('grid_y_id', QVariant.Int, '', 5, 0))  # 格网行ID
        fields.append(QgsField('layer_id', QVariant.Int, '', 3, 0))   # 层ID

        # --- 创建输出 ---
        crs = dsm_layer.crs()
        (sink, dest_id) = self.parameterAsSink(
            parameters, self.OUTPUT, context, fields,
            QgsWkbTypes.PointZ,  # 输出3D点
            crs
        )

        if sink is None:
            raise QgsProcessingException('无法创建输出图层')

        # --- 主循环 ---
        point_count = 0
        skipped_nodata = 0
        dsm_nodata_value = dsm_provider.sourceNoDataValue(1)

        for layer_idx, z in enumerate(z_levels):
            if feedback.isCanceled():
                break

            feedback.setProgress(int(100 * layer_idx / len(z_levels)))
            feedback.pushInfo(f"➡️ 处理第 {layer_idx+1}/{len(z_levels)} 层 (z={z}m)...")

            for x_idx, x in enumerate(x_coords):
                if feedback.isCanceled():
                    break

                for y_idx, y in enumerate(y_coords):
                    # === 采样DSM高程 ===
                    identify_result = dsm_provider.identify(
                        QgsPointXY(x, y),
                        QgsRaster.IdentifyFormatValue
                    )
                    
                    # 检查采样结果有效性
                    if not identify_result.isValid():
                        skipped_nodata += 1
                        continue

                    dsm_z_val = identify_result.results().get(1)
                    if dsm_z_val is None:
                        skipped_nodata += 1
                        continue

                    # ✅ 健壮的NoData判断（处理浮点误差）
                    try:
                        dsm_z = float(dsm_z_val)
                        if dsm_nodata_value is not None:
                            if np.isnan(dsm_z) or np.isclose(dsm_z, dsm_nodata_value, atol=0.001):
                                skipped_nodata += 1
                                continue
                    except (ValueError, TypeError):
                        skipped_nodata += 1
                        continue

                    # === 计算绝对高程 ===
                    z_abs = dsm_z + z

                    # === 创建3D点 ===
                    feat = QgsFeature()
                    geom = QgsGeometry.fromPointXY(QgsPointXY(x, y))
                    geom.get().addZValue(z_abs)  # 关键：赋予Z值
                    feat.setGeometry(geom)
                    
                    # === 设置属性 ===
                    feat.setAttributes([
                        float(x), 
                        float(y), 
                        dsm_z, 
                        float(z), 
                        float(z_abs),
                        int(x_idx),
                        int(y_idx),
                        int(layer_idx)
                    ])
                    
                    sink.addFeature(feat, QgsFeatureSink.FastInsert)
                    point_count += 1

        # --- 完成报告 ---
        feedback.setProgress(100)
        feedback.pushInfo("=" * 50)
        feedback.pushInfo(f"✅ 成功生成 {point_count:,} 个点")
        if skipped_nodata > 0:
            feedback.pushWarning(f"⚠️ 跳过 {skipped_nodata:,} 个无效点 (NoData/异常值)")
        
        feedback.pushInfo(f"📊 统计:")
        feedback.pushInfo(f"   - 有效覆盖率: {point_count/total_expected*100:.1f}%")
        feedback.pushInfo(f"   - 坐标系: {crs.authid()} ({crs.description()})")
        feedback.pushInfo(f"   - 格网尺寸: {dx}m × {dy}m × {dz}m")
        
        if point_count == 0:
            raise QgsProcessingException("未生成有效点，请检查DSM数据和范围")

        return {self.OUTPUT: dest_id}