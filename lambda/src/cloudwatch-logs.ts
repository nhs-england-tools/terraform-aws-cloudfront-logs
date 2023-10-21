import { CloudWatchLogsClient, DescribeLogStreamsCommand, CreateLogStreamCommand, type LogStream, PutLogEventsCommand, type InputLogEvent, type PutLogEventsCommandOutput } from '@aws-sdk/client-cloudwatch-logs'

const client = new CloudWatchLogsClient({
  region: process.env.LOG_GROUP_REGION
})

const groupBy = <T extends Record<string, string>>(array: T[], key: string): Record<string, T[]> => (
  array.reduce<Record<string, T[]>>((object, item) => {
    const result = { ...object }

    if (result[item[key]] !== undefined) {
      result[item[key]].push(item)
    } else if (item[key] !== undefined) {
      result[item[key]] = [item]
    }

    return result
  }, {})
)

const findLogStream = async (logStreamNamePrefix: string): Promise<LogStream | undefined> => {
  const command = new DescribeLogStreamsCommand({
    logGroupName: process.env.LOG_GROUP_NAME,
    logStreamNamePrefix
  })

  const result = await client.send(command)

  const logStreamCount = result.logStreams?.length ?? 0
  if (logStreamCount > 1) {
    throw new Error(`Found '${logStreamCount}' matching CloudWatch Log Streams but expected 1`)
  }

  return result.logStreams?.at(0)
}

const describeLogStream = async (logStreamName: string): Promise<LogStream> => {
  const logStream = await findLogStream(logStreamName)
  if (logStream !== undefined) {
    return logStream
  }

  const command = new CreateLogStreamCommand({
    logGroupName: process.env.LOG_GROUP_NAME,
    logStreamName
  })
  await client.send(command)

  const createdLogStream = await findLogStream(logStreamName)
  if (createdLogStream === undefined) {
    throw new Error(`Created log stream '${command.input.logStreamName}' in group '${command.input.logGroupName}' but it could not be found`)
  }

  return createdLogStream
}

const buildLogEvents = (records: Array<Record<string, string>>): InputLogEvent[] => (
  records.map(record => ({
    message: JSON.stringify({ ...record, name: 'logs:cloudfront' }),
    timestamp: new Date(`${record.date} ${record.time} UTC`).getTime()
  })).sort((a, b) => a.timestamp - b.timestamp)
)

type PutLogEventsFunction = (records: Array<Record<string, string>>) => Promise<PutLogEventsCommandOutput[]>

export const putLogEvents: PutLogEventsFunction = async (records) => {
  const groupedRecords = groupBy(records, 'date')

  const putLogEventsCalls = Object.keys(groupedRecords).map(async (key) => {
    const logStream = await describeLogStream(key)
    const command = new PutLogEventsCommand({
      logEvents: buildLogEvents(groupedRecords[key]),
      logGroupName: process.env.LOG_GROUP_NAME,
      logStreamName: logStream.logStreamName,
      sequenceToken: logStream.uploadSequenceToken
    })
    return await client.send(command)
  })

  return await Promise.all(putLogEventsCalls)
}
