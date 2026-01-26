import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding sensor types...')

  // DHT11 - Temperature and Humidity Sensor
  const dht11 = await prisma.sensorType.upsert({
    where: { name: 'DHT11' },
    update: {},
    create: {
      name: 'DHT11',
      description: 'Digital temperature and humidity sensor',
      category: 'Environmental',
      requiredPins: {
        data: 'digital',
        vcc: '3.3v',
        gnd: 'ground'
      },
      outputs: {
        create: [
          {
            name: 'temperature',
            unit: '°C',
            dataType: 'float',
            minValue: -40,
            maxValue: 80
          },
          {
            name: 'humidity',
            unit: '%',
            dataType: 'float',
            minValue: 0,
            maxValue: 100
          }
        ]
      }
    }
  })

  // DHT22 - More accurate temperature and humidity sensor
  const dht22 = await prisma.sensorType.upsert({
    where: { name: 'DHT22' },
    update: {},
    create: {
      name: 'DHT22',
      description: 'High precision digital temperature and humidity sensor',
      category: 'Environmental',
      requiredPins: {
        data: 'digital',
        vcc: '3.3v',
        gnd: 'ground'
      },
      outputs: {
        create: [
          {
            name: 'temperature',
            unit: '°C',
            dataType: 'float',
            minValue: -40,
            maxValue: 125
          },
          {
            name: 'humidity',
            unit: '%',
            dataType: 'float',
            minValue: 0,
            maxValue: 100
          }
        ]
      }
    }
  })

  // DS18B20 - Temperature sensor
  const ds18b20 = await prisma.sensorType.upsert({
    where: { name: 'DS18B20' },
    update: {},
    create: {
      name: 'DS18B20',
      description: 'Digital temperature sensor with 1-Wire interface',
      category: 'Temperature',
      requiredPins: {
        data: 'digital',
        vcc: '3.3v',
        gnd: 'ground'
      },
      outputs: {
        create: [
          {
            name: 'temperature',
            unit: '°C',
            dataType: 'float',
            minValue: -55,
            maxValue: 125
          }
        ]
      }
    }
  })

  // HC-SR04 - Ultrasonic distance sensor
  const hcsr04 = await prisma.sensorType.upsert({
    where: { name: 'HC-SR04' },
    update: {},
    create: {
      name: 'HC-SR04',
      description: 'Ultrasonic distance sensor',
      category: 'Distance',
      requiredPins: {
        trigger: 'digital',
        echo: 'digital',
        vcc: '5v',
        gnd: 'ground'
      },
      outputs: {
        create: [
          {
            name: 'distance',
            unit: 'cm',
            dataType: 'float',
            minValue: 2,
            maxValue: 400
          }
        ]
      }
    }
  })

  // BMP280 - Pressure and temperature sensor
  const bmp280 = await prisma.sensorType.upsert({
    where: { name: 'BMP280' },
    update: {},
    create: {
      name: 'BMP280',
      description: 'Digital pressure and temperature sensor',
      category: 'Environmental',
      requiredPins: {
        sda: 'digital',
        scl: 'digital',
        vcc: '3.3v',
        gnd: 'ground'
      },
      outputs: {
        create: [
          {
            name: 'pressure',
            unit: 'hPa',
            dataType: 'float',
            minValue: 300,
            maxValue: 1100
          },
          {
            name: 'temperature',
            unit: '°C',
            dataType: 'float',
            minValue: -40,
            maxValue: 85
          }
        ]
      }
    }
  })

  // MQ-2 - Gas sensor
  const mq2 = await prisma.sensorType.upsert({
    where: { name: 'MQ-2' },
    update: {},
    create: {
      name: 'MQ-2',
      description: 'Gas sensor for LPG, propane, hydrogen, etc.',
      category: 'Gas',
      requiredPins: {
        analog: 'analog',
        digital: 'digital',
        vcc: '5v',
        gnd: 'ground'
      },
      outputs: {
        create: [
          {
            name: 'gasLevel',
            unit: 'ppm',
            dataType: 'integer',
            minValue: 0,
            maxValue: 10000
          },
          {
            name: 'gasDetected',
            unit: 'boolean',
            dataType: 'boolean'
          }
        ]
      }
    }
  })

  // PIR Motion Sensor
  const pir = await prisma.sensorType.upsert({
    where: { name: 'PIR' },
    update: {},
    create: {
      name: 'PIR',
      description: 'Passive infrared motion sensor',
      category: 'Motion',
      requiredPins: {
        signal: 'digital',
        vcc: '5v',
        gnd: 'ground'
      },
      outputs: {
        create: [
          {
            name: 'motion',
            unit: 'boolean',
            dataType: 'boolean'
          }
        ]
      }
    }
  })

  // LDR - Light sensor
  const ldr = await prisma.sensorType.upsert({
    where: { name: 'LDR' },
    update: {},
    create: {
      name: 'LDR',
      description: 'Light dependent resistor (photoresistor)',
      category: 'Light',
      requiredPins: {
        analog: 'analog',
        vcc: '3.3v',
        gnd: 'ground'
      },
      outputs: {
        create: [
          {
            name: 'lightLevel',
            unit: 'lux',
            dataType: 'integer',
            minValue: 0,
            maxValue: 1024
          }
        ]
      }
    }
  })

  console.log('Sensor types seeded successfully!')
  console.log({ dht11, dht22, ds18b20, hcsr04, bmp280, mq2, pir, ldr })
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })