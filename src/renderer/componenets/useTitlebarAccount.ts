import { useEffect, useState } from 'react';
import {
  backend,
  imageService,
  loginService,
  opusUsageService,
  taskQueueService,
} from '../models';

type CreditsState = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

interface CreditBalance {
  value: number | undefined;
  state: CreditsState;
  refreshing: boolean;
}

const emptyBalance: CreditBalance = {
  value: undefined,
  state: 'idle',
  refreshing: false,
};

/** The title bar owns display state; existing services own account data and IO. */
export default function useTitlebarAccount() {
  const [loggedIn, setLoggedIn] = useState(loginService.loggedIn);
  const [balance, setBalance] = useState<CreditBalance>(emptyBalance);

  useEffect(() => {
    let mounted = true;
    let accountRevision = 0;
    let { activeProfileId } = loginService;
    let activeRequest: object | undefined;
    let refreshAfterRequest = false;

    const refreshAccount = async (fresh = false): Promise<void> => {
      if (!mounted || !loginService.loggedIn) return;
      if (activeRequest) {
        refreshAfterRequest = refreshAfterRequest || fresh;
        return;
      }

      const revision = accountRevision;
      const request = {};
      activeRequest = request;
      const isCurrentAccount = () => mounted && revision === accountRevision;
      setBalance((previous) => ({
        ...previous,
        state: previous.value === undefined ? 'loading' : 'stale',
        refreshing: true,
      }));

      // A generation may already be refreshing Opus. Join that owner, then
      // read Anlas from its shared /user/data cache rather than forcing it twice.
      const reuseQuotaRequest = fresh && opusUsageService.refreshing;
      const quotaRequest = opusUsageService.refresh(
        fresh && !reuseQuotaRequest,
        { fresh: fresh && !reuseQuotaRequest },
      );
      const readBalance = async () => {
        try {
          if (reuseQuotaRequest) await quotaRequest;
          if (!isCurrentAccount()) return;
          const value = await backend.getRemainCredits({
            force: fresh && !reuseQuotaRequest,
          });
          if (!isCurrentAccount()) return;
          if (!Number.isFinite(value)) {
            throw new Error('Anlas balance is unavailable');
          }
          setBalance({ value, state: 'ready', refreshing: false });
        } catch {
          if (!isCurrentAccount()) return;
          setBalance((previous) => ({
            ...previous,
            state: previous.value === undefined ? 'error' : 'stale',
            refreshing: false,
          }));
          // Existing login validation distinguishes expiry from a network error.
          loginService.refresh().catch(() => undefined);
        }
      };

      await Promise.allSettled([readBalance(), quotaRequest]);
      if (!isCurrentAccount() || activeRequest !== request) return;
      activeRequest = undefined;
      if (refreshAfterRequest) {
        refreshAfterRequest = false;
        // Release this request before starting the next event-driven read.
        // Awaiting recursively would retain every earlier request in a burst.
        requestRefresh(true);
      }
    };

    // Event listeners cannot await their work. Keep an explicit error owner for
    // unexpected service failures, without updating a replacement account.
    function requestRefresh(fresh = false): void {
      const revision = accountRevision;
      const pending = refreshAccount(fresh);
      const request = activeRequest;
      pending.catch(() => {
        if (
          !mounted ||
          revision !== accountRevision ||
          activeRequest !== request
        )
          return;
        activeRequest = undefined;
        refreshAfterRequest = false;
        setBalance((previous) => ({
          ...previous,
          state: previous.value === undefined ? 'error' : 'stale',
          refreshing: false,
        }));
      });
    }

    const onAccountChange = () => {
      accountRevision += 1;
      activeProfileId = loginService.activeProfileId;
      activeRequest = undefined;
      refreshAfterRequest = false;
      setLoggedIn(loginService.loggedIn);
      setBalance(emptyBalance);
      if (!loginService.loggedIn) {
        opusUsageService.clear();
        return;
      }
      opusUsageService.invalidateAccount();
      requestRefresh();
    };
    const onProfilesChange = () => {
      // Renames and list edits do not change the current account. Automatic
      // rotation does change this ID even when login remains true throughout.
      if (activeProfileId !== loginService.activeProfileId) onAccountChange();
    };
    const onComplete = () => {
      requestRefresh(true);
    };

    loginService.addEventListener('change', onAccountChange);
    loginService.addEventListener('token-profiles-change', onProfilesChange);
    taskQueueService.addEventListener('complete', onComplete);
    imageService.addEventListener('encode-vibe', onComplete);
    if (loginService.loggedIn) {
      requestRefresh();
    } else {
      opusUsageService.clear();
    }

    return () => {
      mounted = false;
      accountRevision += 1;
      activeRequest = undefined;
      refreshAfterRequest = false;
      loginService.removeEventListener('change', onAccountChange);
      loginService.removeEventListener(
        'token-profiles-change',
        onProfilesChange,
      );
      taskQueueService.removeEventListener('complete', onComplete);
      imageService.removeEventListener('encode-vibe', onComplete);
    };
  }, []);

  return { loggedIn, balance };
}
