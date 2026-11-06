import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { AppearanceSelector } from '@/components/appearance/AppearanceSelector';
import { Badge, Button, Dialog, TextInput } from '@/components/ui';
import { ProfileAvatar } from './ProfileAvatar';
import {
  DISPLAY_NAME_MAX_LENGTH,
  PRESENCE_OPTIONS,
  PROFILE_AVATARS,
  STATUS_MESSAGE_MAX_LENGTH,
  validateProfileFields,
} from '@/profiles/profileModel';
import type {
  EditableProfileFields,
  ProfileAvatarId,
  ProfileFieldErrors,
  ProfileUpdates,
  PresencePreference,
  UserProfile,
} from '@/profiles/profileModel';

export interface ProfileDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  profile: UserProfile | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  fieldErrors?: ProfileFieldErrors;
  onRetry(): void;
  onSave(updates: ProfileUpdates): Promise<boolean>;
}

const emptyDraft: EditableProfileFields = {
  displayName: '', statusMessage: '', avatar: 'initials', presencePreference: 'available',
};

function profileFields(profile: UserProfile): EditableProfileFields {
  return {
    displayName: profile.displayName,
    statusMessage: profile.statusMessage,
    avatar: profile.avatar,
    presencePreference: profile.presencePreference,
  };
}

export function ProfileDialog({
  error,
  fieldErrors,
  isLoading,
  isSaving,
  onOpenChange,
  onRetry,
  onSave,
  open,
  profile,
}: ProfileDialogProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditableProfileFields>(emptyDraft);
  const [errors, setErrors] = useState<ProfileFieldErrors>({});
  const [saveError, setSaveError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const saveAttempted = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const statusInputRef = useRef<HTMLInputElement>(null);
  const firstAvatarRef = useRef<HTMLInputElement>(null);
  const presenceRef = useRef<HTMLSelectElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const busy = isSaving || submitting;

  useEffect(() => {
    if (!open) {
      setEditing(false);
      setErrors({});
      setSaveError('');
      saveAttempted.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (editing) nameInputRef.current?.focus();
    else if (wasEditing.current) editButtonRef.current?.focus();
    wasEditing.current = editing;
  }, [editing, open]);

  useEffect(() => {
    if (editing && saveAttempted.current && fieldErrors && Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
    }
  }, [editing, fieldErrors]);

  const resetEditor = () => {
    if (profile) setDraft(profileFields(profile));
    setErrors({});
    setSaveError('');
    saveAttempted.current = false;
    setEditing(false);
  };

  const requestOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && busy) return;
    if (!nextOpen) resetEditor();
    onOpenChange(nextOpen);
  };

  const changeField = <Field extends keyof EditableProfileFields>(field: Field, value: EditableProfileFields[Field]) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
    setSaveError('');
  };

  const focusError = (validationErrors: ProfileFieldErrors) => {
    if (validationErrors.displayName) nameInputRef.current?.focus();
    else if (validationErrors.statusMessage) statusInputRef.current?.focus();
    else if (validationErrors.avatar) firstAvatarRef.current?.focus();
    else if (validationErrors.presencePreference) presenceRef.current?.focus();
  };

  const saveProfile = async () => {
    if (busy || submitLock.current) return;
    const validation = validateProfileFields(draft);
    if (!validation.valid) {
      setErrors(validation.errors);
      focusError(validation.errors);
      return;
    }

    submitLock.current = true;
    saveAttempted.current = true;
    setSubmitting(true);
    setErrors({});
    setSaveError('');
    try {
      const accepted = await onSave(validation.value);
      if (accepted) resetEditor();
      else setSaveError('Your profile could not be updated. Your changes are still here.');
    } catch {
      setSaveError('Your profile could not be updated. Your changes are still here.');
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const presenceLabel = PRESENCE_OPTIONS.find((option) => option.value === profile?.presencePreference)?.label ?? 'Available';

  return (
    <Dialog
      open={open}
      onOpenChange={requestOpenChange}
      title="Your profile"
      description="Your local demo identity and preferences."
      closeLabel="Close profile"
      dismissible={!busy}
      className="profile-dialog"
      footer={profile ? (
        <div className="profile-dialog-actions" key={editing ? 'edit-actions' : 'view-actions'}>
          {editing ? (
            <>
              <Button variant="outline" onClick={resetEditor} disabled={busy}>Cancel</Button>
              <Button type="submit" form="profile-settings-form" loading={busy}>Save changes</Button>
            </>
          ) : (
            <Button ref={editButtonRef} onClick={() => {
              setDraft(profileFields(profile));
              setErrors({});
              setSaveError('');
              saveAttempted.current = false;
              setEditing(true);
            }}>Edit profile</Button>
          )}
        </div>
      ) : null}
    >
      {!profile ? (
        <div className="profile-loading-state">
          {isLoading ? <p role="status">Loading your local demo profile…</p> : (
            <>
              <p role="alert">{error ?? 'Your demo profile could not be loaded.'}</p>
              <Button onClick={onRetry}>Try again</Button>
            </>
          )}
        </div>
      ) : editing ? (
        <form id="profile-settings-form" className="profile-form" aria-label="Profile settings" aria-busy={busy} noValidate onSubmit={(event) => {
          event.preventDefault();
          void saveProfile();
        }}>
          <div className="profile-edit-heading">
            <ProfileAvatar displayName={draft.displayName || 'Your profile'} avatar={draft.avatar} />
            <div className="profile-edit-heading-copy">
              <h3 className="display-heading display-heading--section">Profile settings</h3>
              <p>Your user ID and demo username stay the same.</p>
            </div>
          </div>
          <TextInput
            ref={nameInputRef}
            id="profile-display-name"
            label="Display name"
            value={draft.displayName}
            onChange={(event) => changeField('displayName', event.target.value)}
            required
            disabled={busy}
            autoComplete="nickname"
            hint={`Required. Up to ${DISPLAY_NAME_MAX_LENGTH} characters.`}
            {...(errors.displayName ? { error: errors.displayName } : {})}
          />
          <TextInput
            ref={statusInputRef}
            id="profile-status-message"
            label="Status message"
            value={draft.statusMessage}
            onChange={(event) => changeField('statusMessage', event.target.value)}
            disabled={busy}
            hint={`Optional. Up to ${STATUS_MESSAGE_MAX_LENGTH} characters.`}
            {...(errors.statusMessage ? { error: errors.statusMessage } : {})}
          />

          <fieldset className="profile-avatar-field" disabled={busy} aria-describedby={errors.avatar ? 'profile-avatar-error' : 'profile-avatar-hint'}>
            <legend>Avatar</legend>
            <p className="ui-field-message" id="profile-avatar-hint">Choose a look for your local profile.</p>
            <div className="profile-avatar-options">
              {PROFILE_AVATARS.map((preset, index) => (
                <label className={`profile-avatar-option ${draft.avatar === preset.id ? 'is-selected' : ''}`} key={preset.id}>
                  <input
                    ref={index === 0 ? firstAvatarRef : undefined}
                    type="radio"
                    name="profile-avatar"
                    value={preset.id}
                    checked={draft.avatar === preset.id}
                    onChange={() => changeField('avatar', preset.id as ProfileAvatarId)}
                    aria-label={preset.label}
                    aria-describedby={errors.avatar ? 'profile-avatar-error' : 'profile-avatar-hint'}
                  />
                  {draft.avatar === preset.id && (
                    <span className="profile-avatar-selection-check" aria-hidden="true"><Check size={12} /></span>
                  )}
                  <ProfileAvatar displayName={draft.displayName || 'Your profile'} avatar={preset.id} />
                  <span className="profile-avatar-label">{preset.label}</span>
                </label>
              ))}
            </div>
            {errors.avatar && <p className="profile-field-error" id="profile-avatar-error">{errors.avatar}</p>}
          </fieldset>

          <div className="ui-field profile-presence-field">
            <label className="ui-field-label" htmlFor="profile-presence">Presence preference</label>
            <select
              ref={presenceRef}
              id="profile-presence"
              className="ui-input"
              value={draft.presencePreference}
              onChange={(event) => changeField('presencePreference', event.target.value as PresencePreference)}
              disabled={busy}
              aria-invalid={Boolean(errors.presencePreference)}
              aria-describedby={errors.presencePreference ? 'profile-presence-error' : 'profile-presence-hint'}
            >
              {PRESENCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {errors.presencePreference
              ? <p className="profile-field-error" id="profile-presence-error">{errors.presencePreference}</p>
              : <p className="ui-field-message" id="profile-presence-hint">Local preference only. It is not broadcast to other users.</p>}
          </div>

          {saveError && <p className="profile-save-error" role="alert">{error ?? saveError}</p>}
          <p className="profile-local-note">Changes stay in this page and reset on refresh.</p>
        </form>
      ) : (
        <div className="profile-view">
          <div className="profile-summary">
            <ProfileAvatar displayName={profile.displayName} avatar={profile.avatar} size="lg" />
            <div className="profile-summary-identity">
              <h3 className="display-heading display-heading--section">{profile.displayName}</h3>
              <p className="profile-username">@{profile.username}</p>
              <Badge status="info">Local demo identity</Badge>
            </div>
          </div>
          <div className="profile-status">
            <p className="profile-section-label">Status message</p>
            <p className="profile-status-message">{profile.statusMessage || 'No status message yet.'}</p>
          </div>
          <dl className="profile-details">
            <div><dt>Demo username</dt><dd>@{profile.username}</dd></div>
            <div><dt>User ID</dt><dd><code>{profile.id}</code></dd></div>
            <div><dt>Presence preference</dt><dd className="profile-presence">
              <span className="profile-presence-value" data-presence={profile.presencePreference}>
                <span className="profile-presence-dot" aria-hidden="true" />{presenceLabel}
              </span> <span>(local)</span>
            </dd></div>
          </dl>
          <p className="profile-local-note">This is a demo identity, not a registered account. Profile changes reset on refresh. Your presence preference is not broadcast.</p>
          <AppearanceSelector />
        </div>
      )}
    </Dialog>
  );
}
