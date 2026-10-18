import {
  evenHubEventFromJson,
  type AppLocation,
  type AppLocationOptions,
  type AudioInputSource,
  type CreateStartUpPageContainer,
  type DeviceInfo,
  type DeviceStatus,
  type EvenHubEvent,
  type ImuReportPace,
  type LaunchSource,
  type RebuildPageContainer,
  type StartUpPageCreateResult,
  type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import type { HavenBridge } from "../core/bridge";

type Listener<T> = (value: T) => void;

/**
 * In-memory HavenBridge for tests. Records every call and lets tests push host events.
 * `emitHostMessage` runs payloads through the REAL SDK parser (evenHubEventFromJson), so
 * tests see exactly what the SDK hands the app, including protobuf default omissions.
 */
export class FakeBridge implements HavenBridge {
  readonly pages: CreateStartUpPageContainer[] = [];
  readonly rebuilds: RebuildPageContainer[] = [];
  readonly textUpgrades: TextContainerUpgrade[] = [];
  readonly shutdowns: (number | undefined)[] = [];
  readonly audioCalls: { isOpen: boolean; source: AudioInputSource | undefined }[] = [];
  readonly imuCalls: { isOpen: boolean; pace: ImuReportPace | undefined }[] = [];
  readonly storage = new Map<string, string>();
  startUpResult = 0;
  location: AppLocation | null = null;
  locationUpdates = false;

  private hubListeners = new Set<Listener<EvenHubEvent>>();
  private locationListeners = new Set<Listener<AppLocation>>();

  /** Push an already-parsed event. */
  emit(event: EvenHubEvent): void {
    for (const listener of [...this.hubListeners]) listener(event);
  }

  /** Push a raw host message, e.g. `{ type: "sysEvent", jsonData: { eventSource: 1 } }`. */
  emitHostMessage(message: unknown): EvenHubEvent {
    const event = evenHubEventFromJson(message);
    this.emit(event);
    return event;
  }

  emitLocation(location: AppLocation): void {
    for (const listener of [...this.locationListeners]) listener(location);
  }

  listenerCount(): number {
    return this.hubListeners.size;
  }

  async createStartUpPageContainer(container: CreateStartUpPageContainer) {
    this.pages.push(container);
    return this.startUpResult as StartUpPageCreateResult;
  }
  async rebuildPageContainer(container: RebuildPageContainer) {
    this.rebuilds.push(container);
    return true;
  }
  async textContainerUpgrade(container: TextContainerUpgrade) {
    this.textUpgrades.push(container);
    return true;
  }
  async shutDownPageContainer(exitMode?: number) {
    this.shutdowns.push(exitMode);
    return true;
  }
  onEvenHubEvent(callback: Listener<EvenHubEvent>) {
    this.hubListeners.add(callback);
    return () => {
      this.hubListeners.delete(callback);
    };
  }
  async audioControl(isOpen: boolean, source?: AudioInputSource) {
    this.audioCalls.push({ isOpen, source });
    return true;
  }
  async imuControl(isOpen: boolean, reportFrq?: ImuReportPace) {
    this.imuCalls.push({ isOpen, pace: reportFrq });
    return true;
  }
  async getAppLocation(_options?: AppLocationOptions) {
    return this.location;
  }
  async startAppLocationUpdates(_options?: AppLocationOptions) {
    this.locationUpdates = true;
    return true;
  }
  async stopAppLocationUpdates() {
    this.locationUpdates = false;
    return true;
  }
  onAppLocationChanged(callback: Listener<AppLocation>) {
    this.locationListeners.add(callback);
    return () => {
      this.locationListeners.delete(callback);
    };
  }
  async getLocalStorage(key: string) {
    return this.storage.get(key) ?? "";
  }
  async setLocalStorage(key: string, value: string) {
    this.storage.set(key, value);
    return true;
  }
  async getDeviceInfo(): Promise<DeviceInfo | null> {
    return null;
  }
  onDeviceStatusChanged(_callback: Listener<DeviceStatus>) {
    return () => {};
  }
  onLaunchSource(_callback: Listener<LaunchSource>) {
    return () => {};
  }
}
