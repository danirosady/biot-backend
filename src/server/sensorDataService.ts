import { prisma } from './prisma'
import { processTemplate } from './templateProcessor'
import * as tb from './thingsboardClient'

export interface SensorDataInput {
  sensorId: string
  rawData: Record<string, any>
  quality?: 'GOOD' | 'POOR' | 'BAD'
  timestamp?: Date
}

export interface SensorDataQuery {
  sensorId: string
  startTime?: Date
  endTime?: Date
  limit?: number
  includeThingsBoard?: boolean
  aggregation?: {
    interval: number // milliseconds
    function: 'MIN' | 'MAX' | 'AVG' | 'SUM' | 'COUNT'
  }
}

export class SensorDataService {
  
  async storeSensorData(input: SensorDataInput, tenantId: string) {
    // Get sensor configuration
    const sensor = await prisma.sensor.findFirst({
      where: { 
        id: input.sensorId,
        tenantId 
      },
      include: {
        sensorType: { include: { outputs: true } }
      }
    })
    
    if (!sensor) {
      throw new Error('Sensor not found')
    }
    
    // Process template if available
    let formattedOutput: string | undefined
    if (sensor.outputTemplate) {
      const templateData = {
        ...input.rawData,
        deviceName: sensor.deviceName,
        sensorName: sensor.name,
        timestamp: input.timestamp?.toLocaleString() || new Date().toLocaleString()
      }
      formattedOutput = processTemplate(sensor.outputTemplate, templateData)
    }
    
    // Store in local database
    const sensorData = await prisma.sensorData.create({
      data: {
        sensorId: input.sensorId,
        rawData: input.rawData,
        formattedOutput,
        quality: input.quality || 'GOOD',
        timestamp: input.timestamp || new Date()
      }
    })
    
    // Send to ThingsBoard if device is active
    if (sensor.isActive && sensor.deviceId) {
      try {
        // Prepare telemetry data with sensor prefix
        const telemetryData: Record<string, any> = {}
        Object.entries(input.rawData).forEach(([key, value]) => {
          telemetryData[`${sensor.name}_${key}`] = value
        })
        
        // Add formatted output if available
        if (formattedOutput) {
          telemetryData[`${sensor.name}_formatted`] = formattedOutput
        }
        
        // Add metadata
        telemetryData[`${sensor.name}_quality`] = input.quality || 'GOOD'
        telemetryData[`${sensor.name}_timestamp`] = (input.timestamp || new Date()).getTime()
        
        await tb.sendTelemetry(sensor.deviceId, telemetryData)
      } catch (error) {
        console.error('Failed to send telemetry to ThingsBoard:', error)
        // Don't fail the entire operation if ThingsBoard is unavailable
      }
    }
    
    return sensorData
  }
  
  async getSensorData(query: SensorDataQuery, tenantId: string) {
    // Verify sensor belongs to tenant
    const sensor = await prisma.sensor.findFirst({
      where: { 
        id: query.sensorId,
        tenantId 
      },
      include: {
        sensorType: { include: { outputs: true } }
      }
    })
    
    if (!sensor) {
      throw new Error('Sensor not found')
    }
    
    let localData: any[] = []
    let thingsBoardData: any[] = []
    
    // Get local database data
    localData = await prisma.sensorData.findMany({
      where: {
        sensorId: query.sensorId,
        ...(query.startTime && query.endTime ? {
          timestamp: {
            gte: query.startTime,
            lte: query.endTime
          }
        } : {})
      },
      orderBy: { timestamp: 'desc' },
      take: query.limit || 100
    })
    
    // Get ThingsBoard data if requested and device is available
    if (query.includeThingsBoard && sensor.deviceId) {
      try {
        const keys = sensor.sensorType.outputs.map((output: { name: string }) => `${sensor.name}_${output.name}`)
        
        if (query.aggregation) {
          const startTs = query.startTime?.getTime() || Date.now() - 24 * 60 * 60 * 1000
          const endTs = query.endTime?.getTime() || Date.now()
          
          const tbData = await tb.getAggregatedTelemetry(
            sensor.deviceId,
            keys,
            startTs,
            endTs,
            query.aggregation.interval,
            query.aggregation.function
          )
          
          thingsBoardData = this.transformThingsBoardData(tbData, sensor.name)
        } else {
          const tbData = await tb.getLatestTelemetry(sensor.deviceId, keys.join(','))
          thingsBoardData = this.transformThingsBoardData(tbData, sensor.name)
        }
      } catch (error) {
        console.error('Failed to fetch ThingsBoard data:', error)
        // Continue with local data only
      }
    }
    
    return {
      localData,
      thingsBoardData,
      sensor: {
        id: sensor.id,
        name: sensor.name,
        deviceId: sensor.deviceId,
        deviceName: sensor.deviceName,
        sensorType: sensor.sensorType
      }
    }
  }
  
  async deleteSensorData(sensorId: string, tenantId: string, options?: {
    startTime?: Date
    endTime?: Date
    deleteFromThingsBoard?: boolean
  }) {
    // Verify sensor belongs to tenant
    const sensor = await prisma.sensor.findFirst({
      where: { 
        id: sensorId,
        tenantId 
      },
      include: {
        sensorType: { include: { outputs: true } }
      }
    })
    
    if (!sensor) {
      throw new Error('Sensor not found')
    }
    
    // Delete from local database
    await prisma.sensorData.deleteMany({
      where: {
        sensorId,
        ...(options?.startTime && options?.endTime ? {
          timestamp: {
            gte: options.startTime,
            lte: options.endTime
          }
        } : {})
      }
    })
    
    // Delete from ThingsBoard if requested
    if (options?.deleteFromThingsBoard && sensor.deviceId) {
      try {
        const keys = sensor.sensorType.outputs.map((output: { name: string }) => `${sensor.name}_${output.name}`)
        keys.push(`${sensor.name}_formatted`, `${sensor.name}_quality`, `${sensor.name}_timestamp`)
        
        await tb.deleteDeviceTelemetry(
          sensor.deviceId,
          keys,
          !options.startTime && !options.endTime // Delete all if no time range specified
        )
      } catch (error) {
        console.error('Failed to delete ThingsBoard data:', error)
        // Don't fail the operation if ThingsBoard deletion fails
      }
    }
  }
  
  private transformThingsBoardData(tbData: Record<string, Array<{ ts: number; value: any }>>, sensorName: string) {
    const transformed: any[] = []
    
    // Group by timestamp
    const timeGroups: Record<number, any> = {}
    
    Object.entries(tbData).forEach(([key, values]) => {
      const cleanKey = key.replace(`${sensorName}_`, '')
      
      values.forEach(({ ts, value }) => {
        if (!timeGroups[ts]) {
          timeGroups[ts] = {
            timestamp: new Date(ts),
            rawData: {},
            quality: 'GOOD'
          }
        }
        
        if (cleanKey === 'formatted') {
          timeGroups[ts].formattedOutput = value
        } else if (cleanKey === 'quality') {
          timeGroups[ts].quality = value
        } else if (cleanKey !== 'timestamp') {
          timeGroups[ts].rawData[cleanKey] = value
        }
      })
    })
    
    return Object.values(timeGroups).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }
  
  async getSensorDataStats(sensorId: string, tenantId: string, timeRange: {
    startTime: Date
    endTime: Date
  }) {
    // Verify sensor belongs to tenant
    const sensor = await prisma.sensor.findFirst({
      where: { 
        id: sensorId,
        tenantId 
      }
    })
    
    if (!sensor) {
      throw new Error('Sensor not found')
    }
    
    // Get local stats
    const localStats = await prisma.sensorData.aggregate({
      where: {
        sensorId,
        timestamp: {
          gte: timeRange.startTime,
          lte: timeRange.endTime
        }
      },
      _count: { id: true },
      _min: { timestamp: true },
      _max: { timestamp: true }
    })
    
    return {
      totalRecords: localStats._count.id,
      firstRecord: localStats._min.timestamp,
      lastRecord: localStats._max.timestamp,
      timeRange
    }
  }
}

export const sensorDataService = new SensorDataService()