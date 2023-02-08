import { IEventHandler, IWebHookEvent } from "../Interfaces";

export class PullRequestUpdatedEventHandler implements IEventHandler {
  constructor(private event: IWebHookEvent) { }
  execute() {
    throw Error(`NOT IMPLEMENTED EVENT HANDLER ${this.constructor.name}`);
  }
}
