import { IWebHookEvent, IEventHandler, EventType } from "../Interfaces";
import { GitPushedEventHandler } from "./GitPushedEventHandler";
import { PullRequestCreatedEventHandler } from "./PullRequestCreatedEventHandler";
import { PullRequestUpdatedEventHandler } from "./PullRequestUpdatedEventHandler";


export class EventHandlerFactory {
  static getHandler(event: IWebHookEvent): IEventHandler | null {
    switch (event.type) {
      case EventType.GitPushed:
        return new GitPushedEventHandler(event);
      case EventType.PullRequestCreated:
        return new PullRequestCreatedEventHandler(event);
      case EventType.PullRequestUpdated:
        return new PullRequestUpdatedEventHandler(event);
      default:
        console.warn(`No event handler found for event type: ${event.type}`);
        return null;
    }
  }
}


export class EventHandlerDispatcher {
  static async handleEvent(event: IWebHookEvent): Promise<void> {
    const eventHandler = EventHandlerFactory.getHandler(event);
    if (eventHandler) {
      await eventHandler.execute();
    } else {
      console.warn(`Unhandled event type: ${event.type}`);
    }
  }
}