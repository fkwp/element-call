/*
Copyright 2023, 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import {
  connectedParticipantsObserver,
  observeParticipantEvents,
  observeParticipantMedia,
} from "@livekit/components-core";
import {
  Room as LivekitRoom,
  LocalParticipant,
  LocalVideoTrack,
  ParticipantEvent,
  RemoteParticipant,
  Track,
} from "livekit-client";
import {
  Room as MatrixRoom,
  RoomMember,
  RoomStateEvent,
} from "matrix-js-sdk/src/matrix";
import {
  EMPTY,
  Observable,
  Subject,
  combineLatest,
  concat,
  distinctUntilChanged,
  filter,
  forkJoin,
  fromEvent,
  map,
  merge,
  mergeMap,
  of,
  race,
  scan,
  skip,
  startWith,
  switchAll,
  switchMap,
  switchScan,
  take,
  timer,
  withLatestFrom,
} from "rxjs";
import { logger } from "matrix-js-sdk/src/logger";

import { ViewModel } from "./ViewModel";
import {
  ECAddonConnectionState,
  ECConnectionState,
} from "../livekit/useECConnectionState";
import {
  LocalUserMediaViewModel,
  MediaViewModel,
  observeTrackReference,
  RemoteUserMediaViewModel,
  ScreenShareViewModel,
  UserMediaViewModel,
} from "./MediaViewModel";
import { accumulate, finalizeValue } from "../utils/observable";
import { ObservableScope } from "./ObservableScope";
import { duplicateTiles } from "../settings/settings";
import { isFirefox } from "../Platform";
import { setPipEnabled } from "../controls";
import { GridTileViewModel, SpotlightTileViewModel } from "./TileViewModel";
import { TileStore } from "./TileStore";
import { gridLikeLayout } from "./GridLikeLayout";
import { spotlightExpandedLayout } from "./SpotlightExpandedLayout";
import { oneOnOneLayout } from "./OneOnOneLayout";
import { pipLayout } from "./PipLayout";
import { EncryptionSystem } from "../e2ee/sharedKeyManagement";
import { observeSpeaker } from "./observeSpeaker";

// How long we wait after a focus switch before showing the real participant
// list again
const POST_FOCUS_PARTICIPANT_UPDATE_DELAY_MS = 3000;

// This is the number of participants that we think constitutes a "small" call
// on mobile. No spotlight tile should be shown below this threshold.
const smallMobileCallThreshold = 3;

// How long the footer should be shown for when hovering over or interacting
// with the interface
const showFooterMs = 4000;

export interface GridLayoutMedia {
  type: "grid";
  spotlight?: MediaViewModel[];
  grid: UserMediaViewModel[];
}

export interface SpotlightLandscapeLayoutMedia {
  type: "spotlight-landscape";
  spotlight: MediaViewModel[];
  grid: UserMediaViewModel[];
}

export interface SpotlightPortraitLayoutMedia {
  type: "spotlight-portrait";
  spotlight: MediaViewModel[];
  grid: UserMediaViewModel[];
}

export interface SpotlightExpandedLayoutMedia {
  type: "spotlight-expanded";
  spotlight: MediaViewModel[];
  pip?: UserMediaViewModel;
}

export interface OneOnOneLayoutMedia {
  type: "one-on-one";
  local: UserMediaViewModel;
  remote: UserMediaViewModel;
}

export interface PipLayoutMedia {
  type: "pip";
  spotlight: MediaViewModel[];
}

export type LayoutMedia =
  | GridLayoutMedia
  | SpotlightLandscapeLayoutMedia
  | SpotlightPortraitLayoutMedia
  | SpotlightExpandedLayoutMedia
  | OneOnOneLayoutMedia
  | PipLayoutMedia;

export interface GridLayout {
  type: "grid";
  spotlight?: SpotlightTileViewModel;
  grid: GridTileViewModel[];
}

export interface SpotlightLandscapeLayout {
  type: "spotlight-landscape";
  spotlight: SpotlightTileViewModel;
  grid: GridTileViewModel[];
}

export interface SpotlightPortraitLayout {
  type: "spotlight-portrait";
  spotlight: SpotlightTileViewModel;
  grid: GridTileViewModel[];
}

export interface SpotlightExpandedLayout {
  type: "spotlight-expanded";
  spotlight: SpotlightTileViewModel;
  pip?: GridTileViewModel;
}

export interface OneOnOneLayout {
  type: "one-on-one";
  local: GridTileViewModel;
  remote: GridTileViewModel;
}

export interface PipLayout {
  type: "pip";
  spotlight: SpotlightTileViewModel;
}

/**
 * A layout defining the media tiles present on screen and their visual
 * arrangement.
 */
export type Layout =
  | GridLayout
  | SpotlightLandscapeLayout
  | SpotlightPortraitLayout
  | SpotlightExpandedLayout
  | OneOnOneLayout
  | PipLayout;

export type GridMode = "grid" | "spotlight";

export type WindowMode = "normal" | "narrow" | "flat" | "pip";

/**
 * Sorting bins defining the order in which media tiles appear in the layout.
 */
enum SortingBin {
  /**
   * Yourself, when the "always show self" option is on.
   */
  SelfAlwaysShown,
  /**
   * Participants that are sharing their screen.
   */
  Presenters,
  /**
   * Participants that have been speaking recently.
   */
  Speakers,
  /**
   * Participants with video.
   */
  Video,
  /**
   * Participants not sharing any video.
   */
  NoVideo,
  /**
   * Yourself, when the "always show self" option is off.
   */
  SelfNotAlwaysShown,
}

interface LayoutScanState {
  layout: Layout | null;
  tiles: TileStore;
  visibleTiles: Set<GridTileViewModel>;
}

class UserMedia {
  private readonly scope = new ObservableScope();
  public readonly vm: UserMediaViewModel;
  public readonly speaker: Observable<boolean>;
  public readonly presenter: Observable<boolean>;

  public constructor(
    public readonly id: string,
    member: RoomMember | undefined,
    participant: LocalParticipant | RemoteParticipant,
    encryptionSystem: EncryptionSystem,
    livekitRoom: LivekitRoom,
  ) {
    this.vm = participant.isLocal
      ? new LocalUserMediaViewModel(
          id,
          member,
          participant as LocalParticipant,
          encryptionSystem,
          livekitRoom,
        )
      : new RemoteUserMediaViewModel(
          id,
          member,
          participant as RemoteParticipant,
          encryptionSystem,
          livekitRoom,
        );

    this.speaker = observeSpeaker(this.vm.speaking).pipe(this.scope.state());

    this.presenter = observeParticipantEvents(
      participant,
      ParticipantEvent.TrackPublished,
      ParticipantEvent.TrackUnpublished,
      ParticipantEvent.LocalTrackPublished,
      ParticipantEvent.LocalTrackUnpublished,
    ).pipe(map((p) => p.isScreenShareEnabled));
  }

  public destroy(): void {
    this.scope.end();
    this.vm.destroy();
  }
}

class ScreenShare {
  public readonly vm: ScreenShareViewModel;

  public constructor(
    id: string,
    member: RoomMember | undefined,
    participant: LocalParticipant | RemoteParticipant,
    encryptionSystem: EncryptionSystem,
    liveKitRoom: LivekitRoom,
  ) {
    this.vm = new ScreenShareViewModel(
      id,
      member,
      participant,
      encryptionSystem,
      liveKitRoom,
    );
  }

  public destroy(): void {
    this.vm.destroy();
  }
}

type MediaItem = UserMedia | ScreenShare;

function findMatrixRoomMember(
  room: MatrixRoom,
  id: string,
): RoomMember | undefined {
  if (id === "local")
    return room.getMember(room.client.getUserId()!) ?? undefined;

  const parts = id.split(":");
  // must be at least 3 parts because we know the first part is a userId which must necessarily contain a colon
  if (parts.length < 3) {
    logger.warn(
      "Livekit participants ID doesn't look like a userId:deviceId combination",
    );
    return undefined;
  }

  parts.pop();
  const userId = parts.join(":");

  return room.getMember(userId) ?? undefined;
}

// TODO: Move wayyyy more business logic from the call and lobby views into here
export class CallViewModel extends ViewModel {
  public readonly localVideo: Observable<LocalVideoTrack | null> =
    observeTrackReference(
      this.livekitRoom.localParticipant,
      Track.Source.Camera,
    ).pipe(
      map((trackRef) => {
        const track = trackRef.publication?.track;
        return track instanceof LocalVideoTrack ? track : null;
      }),
    );

  /**
   * The raw list of RemoteParticipants as reported by LiveKit
   */
  private readonly rawRemoteParticipants: Observable<RemoteParticipant[]> =
    connectedParticipantsObserver(this.livekitRoom).pipe(this.scope.state());

  /**
   * Lists of RemoteParticipants to "hold" on display, even if LiveKit claims that
   * they've left
   */
  private readonly remoteParticipantHolds: Observable<RemoteParticipant[][]> =
    this.connectionState.pipe(
      withLatestFrom(this.rawRemoteParticipants),
      mergeMap(([s, ps]) => {
        // Whenever we switch focuses, we should retain all the previous
        // participants for at least POST_FOCUS_PARTICIPANT_UPDATE_DELAY_MS ms to
        // give their clients time to switch over and avoid jarring layout shifts
        if (s === ECAddonConnectionState.ECSwitchingFocus) {
          return concat(
            // Hold these participants
            of({ hold: ps }),
            // Wait for time to pass and the connection state to have changed
            forkJoin([
              timer(POST_FOCUS_PARTICIPANT_UPDATE_DELAY_MS),
              this.connectionState.pipe(
                filter((s) => s !== ECAddonConnectionState.ECSwitchingFocus),
                take(1),
              ),
              // Then unhold them
            ]).pipe(map(() => ({ unhold: ps }))),
          );
        } else {
          return EMPTY;
        }
      }),
      // Accumulate the hold instructions into a single list showing which
      // participants are being held
      accumulate([] as RemoteParticipant[][], (holds, instruction) =>
        "hold" in instruction
          ? [instruction.hold, ...holds]
          : holds.filter((h) => h !== instruction.unhold),
      ),
    );

  /**
   * The RemoteParticipants including those that are being "held" on the screen
   */
  private readonly remoteParticipants: Observable<RemoteParticipant[]> =
    combineLatest(
      [this.rawRemoteParticipants, this.remoteParticipantHolds],
      (raw, holds) => {
        const result = [...raw];
        const resultIds = new Set(result.map((p) => p.identity));

        // Incorporate the held participants into the list
        for (const hold of holds) {
          for (const p of hold) {
            if (!resultIds.has(p.identity)) {
              result.push(p);
              resultIds.add(p.identity);
            }
          }
        }

        return result;
      },
    );

  /**
   * List of MediaItems that we want to display
   */
  private readonly mediaItems: Observable<MediaItem[]> = combineLatest([
    this.remoteParticipants,
    observeParticipantMedia(this.livekitRoom.localParticipant),
    duplicateTiles.value,
    // Also react to changes in the list of members
    fromEvent(this.matrixRoom, RoomStateEvent.Update).pipe(startWith(null)),
  ]).pipe(
    scan(
      (
        prevItems,
        [remoteParticipants, { participant: localParticipant }, duplicateTiles],
      ) => {
        const newItems = new Map(
          function* (this: CallViewModel): Iterable<[string, MediaItem]> {
            for (const p of [localParticipant, ...remoteParticipants]) {
              const id = p === localParticipant ? "local" : p.identity;
              const member = findMatrixRoomMember(this.matrixRoom, id);
              if (member === undefined)
                logger.warn(
                  `Ruh, roh! No matrix member found for SFU participant '${p.identity}': creating g-g-g-ghost!`,
                );

              // Create as many tiles for this participant as called for by
              // the duplicateTiles option
              for (let i = 0; i < 1 + duplicateTiles; i++) {
                const userMediaId = `${id}:${i}`;
                yield [
                  userMediaId,
                  prevItems.get(userMediaId) ??
                    new UserMedia(
                      userMediaId,
                      member,
                      p,
                      this.encryptionSystem,
                      this.livekitRoom,
                    ),
                ];

                if (p.isScreenShareEnabled) {
                  const screenShareId = `${userMediaId}:screen-share`;
                  yield [
                    screenShareId,
                    prevItems.get(screenShareId) ??
                      new ScreenShare(
                        screenShareId,
                        member,
                        p,
                        this.encryptionSystem,
                        this.livekitRoom,
                      ),
                  ];
                }
              }
            }
          }.bind(this)(),
        );

        for (const [id, t] of prevItems) if (!newItems.has(id)) t.destroy();
        return newItems;
      },
      new Map<string, MediaItem>(),
    ),
    map((mediaItems) => [...mediaItems.values()]),
    finalizeValue((ts) => {
      for (const t of ts) t.destroy();
    }),
    this.scope.state(),
  );

  /**
   * List of MediaItems that we want to display, that are of type UserMedia
   */
  private readonly userMedia: Observable<UserMedia[]> = this.mediaItems.pipe(
    map((mediaItems) =>
      mediaItems.filter((m): m is UserMedia => m instanceof UserMedia),
    ),
  );

  public readonly memberChanges = this.userMedia
    .pipe(map((mediaItems) => mediaItems.map((m) => m.id)))
    .pipe(
      scan<string[], { ids: string[]; joined: string[]; left: string[] }>(
        (prev, ids) => {
          const left = prev.ids.filter((id) => !ids.includes(id));
          const joined = ids.filter((id) => !prev.ids.includes(id));
          return { ids, joined, left };
        },
        { ids: [], joined: [], left: [] },
      ),
    );

  private readonly localUserMedia: Observable<LocalUserMediaViewModel> =
    this.mediaItems.pipe(
      map((ms) => ms.find((m) => m.vm.local)!.vm as LocalUserMediaViewModel),
    );

  /**
   * List of MediaItems that we want to display, that are of type ScreenShare
   */
  private readonly screenShares: Observable<ScreenShare[]> =
    this.mediaItems.pipe(
      map((mediaItems) =>
        mediaItems.filter((m): m is ScreenShare => m instanceof ScreenShare),
      ),
      this.scope.state(),
    );

  private readonly spotlightSpeaker: Observable<UserMediaViewModel> =
    this.userMedia.pipe(
      switchMap((mediaItems) =>
        mediaItems.length === 0
          ? of([])
          : combineLatest(
              mediaItems.map((m) =>
                m.vm.speaking.pipe(map((s) => [m, s] as const)),
              ),
            ),
      ),
      scan<(readonly [UserMedia, boolean])[], UserMedia, null>(
        (prev, mediaItems) => {
          // Only remote users that are still in the call should be sticky
          const [stickyMedia, stickySpeaking] =
            (!prev?.vm.local && mediaItems.find(([m]) => m === prev)) || [];
          // Decide who to spotlight:
          // If the previous speaker is still speaking, stick with them rather
          // than switching eagerly to someone else
          return stickySpeaking
            ? stickyMedia!
            : // Otherwise, select any remote user who is speaking
              (mediaItems.find(([m, s]) => !m.vm.local && s)?.[0] ??
                // Otherwise, stick with the person who was last speaking
                stickyMedia ??
                // Otherwise, spotlight an arbitrary remote user
                mediaItems.find(([m]) => !m.vm.local)?.[0] ??
                // Otherwise, spotlight the local user
                mediaItems.find(([m]) => m.vm.local)![0]);
        },
        null,
      ),
      map((speaker) => speaker.vm),
      this.scope.state(),
    );

  private readonly grid: Observable<UserMediaViewModel[]> = this.userMedia.pipe(
    switchMap((mediaItems) => {
      const bins = mediaItems.map((m) =>
        combineLatest(
          [
            m.speaker,
            m.presenter,
            m.vm.videoEnabled,
            m.vm instanceof LocalUserMediaViewModel
              ? m.vm.alwaysShow
              : of(false),
          ],
          (speaker, presenter, video, alwaysShow) => {
            let bin: SortingBin;
            if (m.vm.local)
              bin = alwaysShow
                ? SortingBin.SelfAlwaysShown
                : SortingBin.SelfNotAlwaysShown;
            else if (presenter) bin = SortingBin.Presenters;
            else if (speaker) bin = SortingBin.Speakers;
            else if (video) bin = SortingBin.Video;
            else bin = SortingBin.NoVideo;

            return [m, bin] as const;
          },
        ),
      );
      // Sort the media by bin order and generate a tile for each one
      return bins.length === 0
        ? of([])
        : combineLatest(bins, (...bins) =>
            bins.sort(([, bin1], [, bin2]) => bin1 - bin2).map(([m]) => m.vm),
          );
    }),
  );

  private readonly spotlightAndPip: Observable<
    [Observable<MediaViewModel[]>, Observable<UserMediaViewModel | null>]
  > = this.screenShares.pipe(
    map((screenShares) =>
      screenShares.length > 0
        ? ([of(screenShares.map((m) => m.vm)), this.spotlightSpeaker] as const)
        : ([
            this.spotlightSpeaker.pipe(map((speaker) => [speaker!])),
            this.spotlightSpeaker.pipe(
              switchMap((speaker) =>
                speaker.local
                  ? of(null)
                  : this.localUserMedia.pipe(
                      switchMap((vm) =>
                        vm.alwaysShow.pipe(
                          map((alwaysShow) => (alwaysShow ? vm : null)),
                        ),
                      ),
                    ),
              ),
            ),
          ] as const),
    ),
  );

  private readonly spotlight: Observable<MediaViewModel[]> =
    this.spotlightAndPip.pipe(
      switchMap(([spotlight]) => spotlight),
      this.scope.state(),
    );

  private readonly hasRemoteScreenShares: Observable<boolean> =
    this.spotlight.pipe(
      map((spotlight) =>
        spotlight.some((vm) => !vm.local && vm instanceof ScreenShareViewModel),
      ),
      distinctUntilChanged(),
    );

  private readonly pip: Observable<UserMediaViewModel | null> =
    this.spotlightAndPip.pipe(switchMap(([, pip]) => pip));

  private readonly pipEnabled: Observable<boolean> = setPipEnabled.pipe(
    startWith(false),
  );

  private readonly naturalWindowMode: Observable<WindowMode> = fromEvent(
    window,
    "resize",
  ).pipe(
    startWith(null),
    map(() => {
      const height = window.innerHeight;
      const width = window.innerWidth;
      if (height <= 400 && width <= 340) return "pip";
      // Our layouts for flat windows are better at adapting to a small width
      // than our layouts for narrow windows are at adapting to a small height,
      // so we give "flat" precedence here
      if (height <= 600) return "flat";
      if (width <= 600) return "narrow";
      return "normal";
    }),
    this.scope.state(),
  );

  /**
   * The general shape of the window.
   */
  public readonly windowMode: Observable<WindowMode> = this.pipEnabled.pipe(
    switchMap((pip) => (pip ? of<WindowMode>("pip") : this.naturalWindowMode)),
  );

  private readonly spotlightExpandedToggle = new Subject<void>();
  public readonly spotlightExpanded: Observable<boolean> =
    this.spotlightExpandedToggle.pipe(
      accumulate(false, (expanded) => !expanded),
      this.scope.state(),
    );

  private readonly gridModeUserSelection = new Subject<GridMode>();
  /**
   * The layout mode of the media tile grid.
   */
  public readonly gridMode: Observable<GridMode> =
    // If the user hasn't selected spotlight and somebody starts screen sharing,
    // automatically switch to spotlight mode and reset when screen sharing ends
    this.gridModeUserSelection.pipe(
      startWith(null),
      switchMap((userSelection) =>
        (userSelection === "spotlight"
          ? EMPTY
          : combineLatest([this.hasRemoteScreenShares, this.windowMode]).pipe(
              skip(userSelection === null ? 0 : 1),
              map(
                ([hasScreenShares, windowMode]): GridMode =>
                  hasScreenShares || windowMode === "flat"
                    ? "spotlight"
                    : "grid",
              ),
            )
        ).pipe(startWith(userSelection ?? "grid")),
      ),
      this.scope.state(),
    );

  public setGridMode(value: GridMode): void {
    this.gridModeUserSelection.next(value);
  }

  private readonly gridLayoutMedia: Observable<GridLayoutMedia> = combineLatest(
    [this.grid, this.spotlight],
    (grid, spotlight) => ({
      type: "grid",
      spotlight: spotlight.some((vm) => vm instanceof ScreenShareViewModel)
        ? spotlight
        : undefined,
      grid,
    }),
  );

  private readonly spotlightLandscapeLayoutMedia: Observable<SpotlightLandscapeLayoutMedia> =
    combineLatest([this.grid, this.spotlight], (grid, spotlight) => ({
      type: "spotlight-landscape",
      spotlight,
      grid,
    }));

  private readonly spotlightPortraitLayoutMedia: Observable<SpotlightPortraitLayoutMedia> =
    combineLatest([this.grid, this.spotlight], (grid, spotlight) => ({
      type: "spotlight-portrait",
      spotlight,
      grid,
    }));

  private readonly spotlightExpandedLayoutMedia: Observable<SpotlightExpandedLayoutMedia> =
    combineLatest([this.spotlight, this.pip], (spotlight, pip) => ({
      type: "spotlight-expanded",
      spotlight,
      pip: pip ?? undefined,
    }));

  private readonly oneOnOneLayoutMedia: Observable<OneOnOneLayoutMedia | null> =
    this.mediaItems.pipe(
      map((mediaItems) => {
        if (mediaItems.length !== 2) return null;
        const local = mediaItems.find((vm) => vm.vm.local)!
          .vm as LocalUserMediaViewModel;
        const remote = mediaItems.find((vm) => !vm.vm.local)?.vm as
          | RemoteUserMediaViewModel
          | undefined;
        // There might not be a remote tile if there are screen shares, or if
        // only the local user is in the call and they're using the duplicate
        // tiles option
        if (remote === undefined) return null;

        return { type: "one-on-one", local, remote };
      }),
    );

  private readonly pipLayoutMedia: Observable<LayoutMedia> =
    this.spotlight.pipe(map((spotlight) => ({ type: "pip", spotlight })));

  /**
   * The media to be used to produce a layout.
   */
  private readonly layoutMedia: Observable<LayoutMedia> = this.windowMode.pipe(
    switchMap((windowMode) => {
      switch (windowMode) {
        case "normal":
          return this.gridMode.pipe(
            switchMap((gridMode) => {
              switch (gridMode) {
                case "grid":
                  return this.oneOnOneLayoutMedia.pipe(
                    switchMap((oneOnOne) =>
                      oneOnOne === null ? this.gridLayoutMedia : of(oneOnOne),
                    ),
                  );
                case "spotlight":
                  return this.spotlightExpanded.pipe(
                    switchMap((expanded) =>
                      expanded
                        ? this.spotlightExpandedLayoutMedia
                        : this.spotlightLandscapeLayoutMedia,
                    ),
                  );
              }
            }),
          );
        case "narrow":
          return this.oneOnOneLayoutMedia.pipe(
            switchMap((oneOnOne) =>
              oneOnOne === null
                ? combineLatest(
                    [this.grid, this.spotlight],
                    (grid, spotlight) =>
                      grid.length > smallMobileCallThreshold ||
                      spotlight.some((vm) => vm instanceof ScreenShareViewModel)
                        ? this.spotlightPortraitLayoutMedia
                        : this.gridLayoutMedia,
                  ).pipe(switchAll())
                : // The expanded spotlight layout makes for a better one-on-one
                  // experience in narrow windows
                  this.spotlightExpandedLayoutMedia,
            ),
          );
        case "flat":
          return this.gridMode.pipe(
            switchMap((gridMode) => {
              switch (gridMode) {
                case "grid":
                  // Yes, grid mode actually gets you a "spotlight" layout in
                  // this window mode.
                  return this.spotlightLandscapeLayoutMedia;
                case "spotlight":
                  return this.spotlightExpandedLayoutMedia;
              }
            }),
          );
        case "pip":
          return this.pipLayoutMedia;
      }
    }),
    this.scope.state(),
  );

  /**
   * The layout of tiles in the call interface.
   */
  public readonly layout: Observable<Layout> = this.layoutMedia.pipe(
    // Each layout will produce a set of tiles, and these tiles have an
    // observable indicating whether they're visible. We loop this information
    // back into the layout process by using switchScan.
    switchScan<
      LayoutMedia,
      LayoutScanState,
      Observable<LayoutScanState & { layout: Layout }>
    >(
      ({ tiles: prevTiles, visibleTiles }, media) => {
        let layout: Layout;
        let newTiles: TileStore;
        switch (media.type) {
          case "grid":
          case "spotlight-landscape":
          case "spotlight-portrait":
            [layout, newTiles] = gridLikeLayout(media, visibleTiles, prevTiles);
            break;
          case "spotlight-expanded":
            [layout, newTiles] = spotlightExpandedLayout(
              media,
              visibleTiles,
              prevTiles,
            );
            break;
          case "one-on-one":
            [layout, newTiles] = oneOnOneLayout(media, visibleTiles, prevTiles);
            break;
          case "pip":
            [layout, newTiles] = pipLayout(media, visibleTiles, prevTiles);
            break;
        }

        // Take all of the 'visible' observables and combine them into one big
        // observable array
        const visibilities =
          newTiles.gridTiles.length === 0
            ? of([])
            : combineLatest(newTiles.gridTiles.map((tile) => tile.visible));
        return visibilities.pipe(
          map((visibilities) => ({
            layout: layout,
            tiles: newTiles,
            visibleTiles: new Set(
              newTiles.gridTiles.filter((_tile, i) => visibilities[i]),
            ),
          })),
        );
      },
      {
        layout: null,
        tiles: TileStore.empty(),
        visibleTiles: new Set(),
      },
    ),
    map(({ layout }) => layout),
    this.scope.state(),
  );

  public showSpotlightIndicators: Observable<boolean> = this.layout.pipe(
    map((l) => l.type !== "grid"),
    this.scope.state(),
  );

  public showSpeakingIndicators: Observable<boolean> = this.layout.pipe(
    switchMap((l) => {
      switch (l.type) {
        case "spotlight-landscape":
        case "spotlight-portrait":
          // If the spotlight is showing the active speaker, we can do without
          // speaking indicators as they're a redundant visual cue. But if
          // screen sharing feeds are in the spotlight we still need them.
          return l.spotlight.media.pipe(
            map((models: MediaViewModel[]) =>
              models.some((m) => m instanceof ScreenShareViewModel),
            ),
          );
        // In expanded spotlight layout, the active speaker is always shown in
        // the picture-in-picture tile so there is no need for speaking
        // indicators. And in one-on-one layout there's no question as to who is
        // speaking.
        case "spotlight-expanded":
        case "one-on-one":
          return of(false);
        default:
          return of(true);
      }
    }),
    this.scope.state(),
  );

  public readonly toggleSpotlightExpanded: Observable<(() => void) | null> =
    this.windowMode.pipe(
      switchMap((mode) =>
        mode === "normal"
          ? this.layout.pipe(
              map(
                (l) =>
                  l.type === "spotlight-landscape" ||
                  l.type === "spotlight-expanded",
              ),
            )
          : of(false),
      ),
      distinctUntilChanged(),
      map((enabled) =>
        enabled ? (): void => this.spotlightExpandedToggle.next() : null,
      ),
      this.scope.state(),
    );

  private readonly screenTap = new Subject<void>();
  private readonly controlsTap = new Subject<void>();
  private readonly screenHover = new Subject<void>();
  private readonly screenUnhover = new Subject<void>();

  /**
   * Callback for when the user taps the call view.
   */
  public tapScreen(): void {
    this.screenTap.next();
  }

  /**
   * Callback for when the user taps the call's controls.
   */
  public tapControls(): void {
    this.controlsTap.next();
  }

  /**
   * Callback for when the user hovers over the call view.
   */
  public hoverScreen(): void {
    this.screenHover.next();
  }

  /**
   * Callback for when the user stops hovering over the call view.
   */
  public unhoverScreen(): void {
    this.screenUnhover.next();
  }

  public readonly showHeader: Observable<boolean> = this.windowMode.pipe(
    map((mode) => mode !== "pip" && mode !== "flat"),
    this.scope.state(),
  );

  public readonly showFooter: Observable<boolean> = this.windowMode.pipe(
    switchMap((mode) => {
      switch (mode) {
        case "pip":
          return of(false);
        case "normal":
        case "narrow":
          return of(true);
        case "flat":
          // Sadly Firefox has some layering glitches that prevent the footer
          // from appearing properly. They happen less often if we never hide
          // the footer.
          if (isFirefox()) return of(true);
          // Show/hide the footer in response to interactions
          return merge(
            this.screenTap.pipe(map(() => "tap screen" as const)),
            this.controlsTap.pipe(map(() => "tap controls" as const)),
            this.screenHover.pipe(map(() => "hover" as const)),
          ).pipe(
            switchScan((state, interaction) => {
              switch (interaction) {
                case "tap screen":
                  return state
                    ? // Toggle visibility on tap
                      of(false)
                    : // Hide after a timeout
                      timer(showFooterMs).pipe(
                        map(() => false),
                        startWith(true),
                      );
                case "tap controls":
                  // The user is interacting with things, so reset the timeout
                  return timer(showFooterMs).pipe(
                    map(() => false),
                    startWith(true),
                  );
                case "hover":
                  // Show on hover and hide after a timeout
                  return race(
                    timer(showFooterMs),
                    this.screenUnhover.pipe(take(1)),
                  ).pipe(
                    map(() => false),
                    startWith(true),
                  );
              }
            }, false),
            startWith(false),
          );
      }
    }),
    this.scope.state(),
  );

  public constructor(
    // A call is permanently tied to a single Matrix room and LiveKit room
    private readonly matrixRoom: MatrixRoom,
    private readonly livekitRoom: LivekitRoom,
    private readonly encryptionSystem: EncryptionSystem,
    private readonly connectionState: Observable<ECConnectionState>,
  ) {
    super();
  }
}
