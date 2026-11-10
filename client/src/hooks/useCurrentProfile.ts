import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ProfileValidationError,
  type PresencePreference,
  type ProfileFieldErrors,
  type ProfileUpdates,
  type UserProfile,
} from '@/profiles/profileModel';
import { LocalDemoProfileService, type ProfileService } from '@/profiles/profileService';

export interface UseCurrentProfileResult {
  profile: UserProfile | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  fieldErrors: ProfileFieldErrors;
  loadProfile(): Promise<void>;
  updateProfile(updates: ProfileUpdates): Promise<boolean>;
  setPresencePreference(preference: PresencePreference): Promise<boolean>;
}

export function useCurrentProfile(providedService?: ProfileService): UseCurrentProfileResult {
  const [localService] = useState(() => providedService ?? new LocalDemoProfileService());
  const service = providedService ?? localService;
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>({});
  const mounted = useRef(false);
  const currentService = useRef(service);
  currentService.current = service;
  const saveLock = useRef(false);
  const loadSequence = useRef(0);
  const profileRevision = useRef(0);

  const loadProfile = useCallback(async () => {
    const request = ++loadSequence.current;
    const revision = profileRevision.current;
    if (mounted.current) {
      setIsLoading(true);
      setError(null);
      setFieldErrors({});
    }
    try {
      const loaded = await service.getCurrentProfile();
      if (!mounted.current || currentService.current !== service || request !== loadSequence.current) return;
      if (revision === profileRevision.current) setProfile({ ...loaded });
    } catch {
      if (mounted.current && currentService.current === service && request === loadSequence.current) {
        setError('Your local profile could not be loaded. Try again.');
      }
    } finally {
      if (mounted.current && currentService.current === service && request === loadSequence.current) setIsLoading(false);
    }
  }, [service]);

  useEffect(() => {
    mounted.current = true;
    setProfile(null);
    saveLock.current = false;
    setIsSaving(false);
    const unsubscribe = service.subscribeToProfileChanges((updated) => {
      if (!mounted.current || currentService.current !== service) return;
      profileRevision.current += 1;
      setProfile({ ...updated });
    });
    void loadProfile();
    return () => {
      mounted.current = false;
      loadSequence.current += 1;
      unsubscribe();
    };
  }, [loadProfile, service]);

  const save = useCallback(async (operation: () => Promise<UserProfile>): Promise<boolean> => {
    if (saveLock.current || !mounted.current) return false;
    saveLock.current = true;
    setIsSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const updated = await operation();
      if (!mounted.current || currentService.current !== service) return false;
      profileRevision.current += 1;
      setProfile({ ...updated });
      return true;
    } catch (failure) {
      if (mounted.current && currentService.current === service) {
        if (failure instanceof ProfileValidationError) {
          setFieldErrors({ ...failure.fieldErrors });
          setError('Please check the highlighted profile fields.');
        } else {
          setError('Your profile could not be updated. Your changes have not been saved.');
        }
      }
      return false;
    } finally {
      if (currentService.current === service) {
        saveLock.current = false;
        if (mounted.current) setIsSaving(false);
      }
    }
  }, [service]);

  const updateProfile = useCallback((updates: ProfileUpdates) => save(() => service.updateProfile(updates)), [save, service]);
  const setPresencePreference = useCallback((preference: PresencePreference) =>
    save(() => service.setPresencePreference(preference)), [save, service]);

  return { profile, isLoading, isSaving, error, fieldErrors, loadProfile, updateProfile, setPresencePreference };
}
