import { SQSEvent } from 'aws-lambda';
import { EventHandlerDispatcher } from './events/EventHandlerDispatcher';
import { IWebHookEvent } from './Interfaces';
import * as fs from 'fs';

const sqsEvent: SQSEvent = JSON.parse(fs.readFileSync('./sqs-event.json', 'utf8'));

Promise.all(sqsEvent.Records.map(async (record) => {
  const webhookEvent: IWebHookEvent = JSON.parse(record.body)
  await EventHandlerDispatcher.handleEvent(webhookEvent);
}));