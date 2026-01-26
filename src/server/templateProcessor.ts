export interface TemplateData {
  [key: string]: any
  timestamp?: string
  date?: string
  time?: string
  deviceName?: string
  sensorName?: string
}

export function processTemplate(template: string, data: TemplateData): string {
  let result = template
  
  // Add system variables if not provided
  const now = new Date()
  const processData = {
    ...data,
    timestamp: data.timestamp || now.toLocaleString(),
    date: data.date || now.toLocaleDateString(),
    time: data.time || now.toLocaleTimeString(),
    newline: '\n',
    tab: '\t',
    space: ' '
  }
  
  // Replace all template variables
  Object.entries(processData).forEach(([key, value]) => {
    const regex = new RegExp(`{%${key}}`, 'g')
    result = result.replace(regex, String(value))
  })
  
  return result
}

export function validateTemplate(template: string, availableVariables: string[]): { isValid: boolean; errors: string[] } {
  const errors: string[] = []
  const variableRegex = /{%([^}]+)}/g
  const matches = template.matchAll(variableRegex)
  
  const systemVariables = ['timestamp', 'date', 'time', 'deviceName', 'sensorName', 'newline', 'tab', 'space']
  const allValidVariables = [...availableVariables, ...systemVariables]
  
  for (const match of matches) {
    const variableName = match[1]
    if (!allValidVariables.includes(variableName)) {
      errors.push(`Unknown variable: {%${variableName}}`)
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  }
}