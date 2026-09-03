import type { ChangeEvent } from "react";
import { useEffect } from "react";
import { preprocessContactAvatarFile } from "../avatar/contactAvatarImage";
import { type PlatformAccountQueryResource } from "../api/platformAccountClient";
import { asErrorDto } from "./appDomain";
import { platformAccountClient } from "./appRuntime";
import type { RailMode } from "./appTypes";
import type { AppState } from "./useAppState";

export function useRailPlatformController(appState: AppState) {
  const {
    railNavRef, setRailNavScrollState, activeView, mailFolders, mailLabels, mailTaxonomySectionExpanded, railCollapsed, railExpandedReady,
    railMode, setLastPlatformQuery, setPlatformSession, setStatusMessage, setError, setPlatformAccountMenuOpen, platformAccountSignedIn, setRailMode,
    setRailModePickerOpen, setActiveView, setRailExpandedReady, setRailCollapsed, setBusy, setPlatformAccountSignedIn, platformAvatarFileInputRef, setPlatformAccountAvatarDataUrl,
  } = appState;
  function updateRailNavScrollState() {
      const nav = railNavRef.current;
      if (!nav) {
        setRailNavScrollState({ top: false, bottom: false });
        return;
      }
      const top = nav.scrollTop > 2;
      const bottom = nav.scrollTop + nav.clientHeight < nav.scrollHeight - 2;
      setRailNavScrollState((current) =>
        current.top === top && current.bottom === bottom ? current : { top, bottom },
      );
    }
  useEffect(() => {
      const animationFrame = window.requestAnimationFrame(updateRailNavScrollState);
      const nav = railNavRef.current;
      const resizeObserver =
        typeof ResizeObserver === "undefined" || !nav
          ? null
          : new ResizeObserver(() => {
              window.requestAnimationFrame(updateRailNavScrollState);
            });
      if (nav) {
        resizeObserver?.observe(nav);
      }
      window.addEventListener("resize", updateRailNavScrollState);
      return () => {
        window.cancelAnimationFrame(animationFrame);
        resizeObserver?.disconnect();
        window.removeEventListener("resize", updateRailNavScrollState);
      };
    }, [
      activeView,
      mailFolders,
      mailLabels,
      mailTaxonomySectionExpanded,
      railCollapsed,
      railExpandedReady,
      railMode,
    ]);
  async function queryPlatformAccount(resource: PlatformAccountQueryResource) {
      try {
        const result = await platformAccountClient.queryPlatformAccountData({ resource });
        setLastPlatformQuery(result);
        if (resource === "session") {
          const session = await platformAccountClient.getPlatformAccountSession();
          setPlatformSession(session);
        }
        setStatusMessage(`平台账户查询 ${resource} 已返回：${result.status}。`);
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      }
    }
  function openPlatformAccountPopover() {
      setPlatformAccountMenuOpen(true);
      if (platformAccountSignedIn) {
        void queryPlatformAccount("profile");
      }
    }
  function selectRailMode(mode: RailMode) {
      setRailMode(mode);
      setRailModePickerOpen(false);
      setActiveView(mode === "mail" ? "mail" : "agent");
    }
  function toggleRailModePicker() {
      if (!railCollapsed) {
        return;
      }
      setRailModePickerOpen((value) => !value);
    }
  function expandRail() {
      setRailModePickerOpen(false);
      setRailExpandedReady(false);
      setRailCollapsed(false);
    }
  function collapseRail() {
      setRailModePickerOpen(false);
      setRailExpandedReady(false);
      setRailCollapsed(true);
    }
  async function signInPlatformAccount() {
      setBusy(true);
      try {
        const session = await platformAccountClient.getPlatformAccountSession();
        setPlatformSession(session);
        setPlatformAccountSignedIn(true);
        setPlatformAccountMenuOpen(true);
        setStatusMessage("已登录 NMail 开发预览账户。");
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  function signOutPlatformAccount() {
      setPlatformAccountSignedIn(false);
      setLastPlatformQuery(null);
      setStatusMessage("已退出 NMail 开发预览账户。");
      setError(null);
    }
  function choosePlatformAvatarFile() {
      setPlatformAccountMenuOpen(false);
      platformAvatarFileInputRef.current?.click();
    }
  async function handlePlatformAvatarFile(event: ChangeEvent<HTMLInputElement>) {
      const file = event.currentTarget.files?.[0] ?? null;
      event.currentTarget.value = "";
      if (!file) {
        return;
      }

      setBusy(true);
      try {
        const imageDataUrl = await preprocessContactAvatarFile(file);
        setPlatformAccountAvatarDataUrl(imageDataUrl);
        window.localStorage.setItem("nmail.platformAccountAvatarDataUrl", imageDataUrl);
        setStatusMessage("已更新平台账户图标。");
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  return {
    updateRailNavScrollState, openPlatformAccountPopover, selectRailMode, toggleRailModePicker, expandRail, collapseRail, signInPlatformAccount, signOutPlatformAccount,
    choosePlatformAvatarFile, handlePlatformAvatarFile,
  };
}

export type UseRailPlatformControllerResult = ReturnType<typeof useRailPlatformController>;
