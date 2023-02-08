import { SQSEvent } from 'aws-lambda';
import { EventHandlerDispatcher } from './events/EventHandlerDispatcher';
import { IWebHookEvent } from './Interfaces';
/**
 * 
 * @param event An object include an array of SQS Records
 * @param context 
 */
export async function handler(event: SQSEvent, context: any): Promise<any> {
  try {
    console.info("event", event, "context", context);
    if (event.Records.length != 1) {
      throw new Error(`To ensure wehhook event trigger does not block others, only 1 record can be send to Lambda event at a time`);
    };

    await Promise.all(event.Records.map(async (record) => {
      const webhookEvent: IWebHookEvent = JSON.parse(record.body)
      await EventHandlerDispatcher.handleEvent(webhookEvent);
    }));
  } catch (error) {
    console.error("Error processing SQS message", error);
  }
}