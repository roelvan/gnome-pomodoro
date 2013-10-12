/*
 * Copyright (c) 2011-2013 gnome-shell-pomodoro contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
 *
 * Authors: Kamil Prusko <kamilprusko@gmail.com>
 *
 */

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Signals = imports.signals;

const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GnomeDesktop = imports.gi.GnomeDesktop;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Pango = imports.gi.Pango;

const GrabHelper = imports.ui.grabHelper;
const Layout = imports.ui.layout;
const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Tweener = imports.ui.tweener;
const ExtensionUtils = imports.misc.extensionUtils;
const Util = imports.misc.util;

const Extension = imports.misc.extensionUtils.getCurrentExtension();
const Utils = Extension.imports.utils;

const Gettext = imports.gettext.domain('gnome-pomodoro');
const _ = Gettext.gettext;
const ngettext = Gettext.ngettext;


// Notification dialog blocks user input for a time corresponding to slow typing speed
// of 23 words per minute which translates to 523 miliseconds between key presses,
// and moderate typing speed of 35 words per minute / 343 miliseconds.
// Pressing Enter key takes longer, so more time needed.
const IDLE_TIME_TO_PUSH_MODAL = 600;
// Time after which stop trying to open a dialog and open a notification
const PUSH_MODAL_TIME_LIMIT = 1000;
// Rate per second at which try opening a dialog
const PUSH_MODAL_RATE = Clutter.get_default_frame_rate();

// Time to (re)open notification dialog if user is idle
const IDLE_TIME_TO_OPEN = 60000;
// Time to determine activity after which notification dialog is closed
const IDLE_TIME_TO_CLOSE = 600;
// Time before user activity is being monitored
const MIN_DISPLAY_TIME = 300;
// Time to fade-in screen notification
const FADE_IN_TIME = 180;
// Time to fade-out screen notification
const FADE_OUT_TIME = 180;

const NOTIFICATION_DIALOG_OPACITY = 0.55;

const ICON_NAME = 'timer-symbolic';

// Remind about ongoing break in given delays
const REMINDER_INTERVALS = [75];
// Ratio between user idle time and time between reminders to determine
// whether user is away
const REMINDER_ACCEPTANCE = 0.66

const State = {
    OPENED: 0,
    CLOSED: 1,
    OPENING: 2,
    CLOSING: 3
};

const Action = {
    SWITCH_TO_POMODORO: 'switch-to-pomodoro',
    SWITCH_TO_PAUSE: 'switch-to-pause',
    SWITCH_TO_SHORT_PAUSE: 'switch-to-short-pause',
    SWITCH_TO_LONG_PAUSE: 'switch-to-long-pause',
    REPORT_BUG: 'report-bug',
    VISIT_WEBSITE: 'visit-website'
};


// ModalDialog class is based on ModalDialog from GNOME Shell. We need our own
// class to have more event signals, different fade in/out times, and different
// event blocking behavior
const ModalDialog = new Lang.Class({
    Name: 'PomodoroModalDialog',

    _init: function() {
        this.state = State.CLOSED;

        this._idleMonitor = new GnomeDesktop.IdleMonitor();
        this._pushModalDelaySource = 0;
        this._pushModalWatchId = 0;
        this._pushModalSource = 0;
        this._pushModalTries = 0;

        this._group = new St.Widget({ visible: false,
                                      x: 0,
                                      y: 0,
                                      accessible_role: Atk.Role.DIALOG });
        Main.uiGroup.add_actor(this._group);

        let constraint = new Clutter.BindConstraint({ source: global.stage,
                                                      coordinate: Clutter.BindCoordinate.ALL });
        this._group.add_constraint(constraint);
        this._group.opacity = 0;
        this._group.connect('destroy', Lang.bind(this, this._onGroupDestroy));

        this._backgroundBin = new St.Bin();
        this._monitorConstraint = new Layout.MonitorConstraint();
        this._backgroundBin.add_constraint(this._monitorConstraint);
        this._group.add_actor(this._backgroundBin);

        this._dialogLayout = new St.BoxLayout({ style_class: 'extension-pomodoro-dialog-layout',
                                                vertical:    true });

        this._lightbox = new Lightbox.Lightbox(this._group,
                                               { fadeFactor: NOTIFICATION_DIALOG_OPACITY,
                                                 inhibitEvents: false });
        this._lightbox.highlight(this._backgroundBin);
        this._lightbox.actor.style_class = 'extension-pomodoro-lightbox';
        this._lightbox.show();

        this._backgroundBin.child = this._dialogLayout;

        this.contentLayout = new St.BoxLayout({ vertical: true });
        this._dialogLayout.add(this.contentLayout,
                               { x_fill:  true,
                                 y_fill:  true,
                                 x_align: St.Align.MIDDLE,
                                 y_align: St.Align.START });

        this._grabHelper = new GrabHelper.GrabHelper(this._group);
        this._grabHelper.addActor(this._lightbox.actor);

        global.focus_manager.add_group(this._group);
    },

    open: function(timestamp) {
        if (this.state == State.OPENED || this.state == State.OPENING) {
            return;
        }

        this.state = State.OPENING;

        if (this._pushModalDelaySource == 0) {
            this._pushModalDelaySource = Mainloop.timeout_add(
                        Math.max(MIN_DISPLAY_TIME - IDLE_TIME_TO_PUSH_MODAL, 0),
                        Lang.bind(this, this._onPushModalDelayTimeout));
        }

        this._monitorConstraint.index = global.screen.get_current_monitor();
        this._group.show();

        Tweener.addTween(this._group,
                         { opacity: 255,
                           time: FADE_IN_TIME / 1000.0,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this,
                                function() {
                                    if (this.state == State.OPENING) {
                                        this.state = State.OPENED;
                                        this.emit('opened');
                                    }
                                })
                         });
        this.emit('opening');

        Main.messageTray.close();
    },

    close: function(timestamp) {
        this.popModal(timestamp);

        if (this.state == State.CLOSED || this.state == State.CLOSING) {
            return;
        }

        this.state = State.CLOSING;

        Tweener.addTween(this._group,
                         { opacity: 0,
                           time: FADE_OUT_TIME / 1000.0,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this,
                               function() {
                                    if (this.state == State.CLOSING) {
                                        this.state = State.CLOSED;
                                        this._group.hide();
                                        this.emit('closed');
                                    }
                               })
                         });
        this.emit('closing');
    },

    _onPushModalDelayTimeout: function() {
        /* Don't become modal and block events just yet,
         * wait until user becomes idle.
         */
        if (this._pushModalWatchId == 0) {
            this._pushModalWatchId = this._idleMonitor.add_idle_watch(IDLE_TIME_TO_PUSH_MODAL, Lang.bind(this,
                function(monitor) {
                    this._idleMonitor.remove_watch(this._pushModalWatchId);
                    this._pushModalWatchId = 0;

                    this.pushModal(global.get_current_time());
                }
            ));
        }

        return false;
    },

    _pushModal: function(timestamp) {
        if (this.state == State.CLOSED || this.state == State.CLOSING) {
            return false;
        }

        this._lightbox.actor.reactive = true;

        this._grabHelper.ignoreRelease();

        return this._grabHelper.grab({
            actor: this._lightbox.actor,
            modal: true,
            onUngrab: Lang.bind(this, this._onUngrab)
        });
    },

    _onPushModalTimeout: function() {
        if (this.state == State.CLOSED || this.state == State.CLOSING) {
            return false;
        }

        this._pushModalTries += 1;

        if (this._pushModal(global.get_current_time())) {
            return false; /* dialog finally opened */
        }

        if (this._pushModalTries > PUSH_MODAL_TIME_LIMIT * PUSH_MODAL_RATE) {
            this.close();
            return false; /* dialog can't become modal */
        }

        return true;
    },

    pushModal: function(timestamp) {
        if (this.state == State.CLOSED || this.state == State.CLOSING) {
            return;
        }

        this._disconnectInternals();

        /* delay pushModal to ignore current events */
        Mainloop.idle_add(Lang.bind(this,
            function() {
                this._pushModalTries = 1;

                if (this._pushModal(global.get_current_time())) {
                    /* dialog became modal */
                }
                else {
                    this._pushModalSource = Mainloop.timeout_add(parseInt(1000 / PUSH_MODAL_RATE),
                                                                 Lang.bind(this, this._onPushModalTimeout));
                }

                return false;
            }
        ));
    },

    /**
     * Drop modal status without closing the dialog; this makes the
     * dialog insensitive as well, so it needs to be followed shortly
     * by either a close() or a pushModal()
     */
    popModal: function(timestamp) {
        this._disconnectInternals();

        this._grabHelper.ungrab({
            actor: this._lightbox.actor
        });

        this._lightbox.actor.reactive = false;
    },

    _disconnectInternals: function() {
        if (this._pushModalDelaySource != 0) {
            GLib.source_remove(this._pushModalDelaySource);
            this._pushModalDelaySource = 0;
        }
        if (this._pushModalSource != 0) {
            GLib.source_remove(this._pushModalSource);
            this._pushModalSource = 0;
        }
        if (this._pushModalWatchId != 0) {
            this._idleMonitor.remove_watch(this._pushModalWatchId);
            this._pushModalWatchId = 0;
        }
    },

    _onGroupDestroy: function() {
        this.close();
        this.emit('destroy');
    },

    _onUngrab: function() {
        this.close();
    },

    destroy: function() {
        this._group.destroy();
    }
});
Signals.addSignalMethods(ModalDialog.prototype);


const PomodoroEndDialog = new Lang.Class({
    Name: 'PomodoroEndDialog',
    Extends: ModalDialog,

    _init: function() {
        this.parent();

        this._description = _("It's time to take a break");

        this._openIdleWatchId = 0;
        this._openWhenIdleWatchId = 0;
        this._closeWhenActiveWatchId = 0;

        let mainLayout = new St.BoxLayout({ style_class: 'extension-pomodoro-dialog-main-layout',
                                            vertical: false });

        let messageBox = new St.BoxLayout({ style_class: 'extension-pomodoro-dialog-message-layout',
                                            vertical: true });

        this._timerLabel = new St.Label({ style_class: 'extension-pomodoro-dialog-timer' });

        this._descriptionLabel = new St.Label({ style_class: 'extension-pomodoro-dialog-message',
                                                text: this._description });
        this._descriptionLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._descriptionLabel.clutter_text.line_wrap = true;

        messageBox.add(this._timerLabel,
                            { y_fill:  false,
                              y_align: St.Align.START });
        messageBox.add(this._descriptionLabel,
                            { y_fill:  true,
                              y_align: St.Align.START });
        mainLayout.add(messageBox,
                            { x_fill: true,
                              y_align: St.Align.START });
        this.contentLayout.add(mainLayout,
                            { x_fill: true,
                              y_fill: true });

        this.setElapsedTime(0, 0);
    },

    /**
     * Open the dialog and setup closing by user activity.
     */
    open: function(timestamp) {
        this.parent(timestamp);

        /* Delay scheduling of closing the dialog by activity
         * until user has chance to see it.
         */
        Mainloop.timeout_add(MIN_DISPLAY_TIME, Lang.bind(this,
            function() {
                /* Wait until user becomes slightly idle */
                if (this._idleMonitor.get_idletime() < IDLE_TIME_TO_CLOSE) {
                    this._openIdleWatchId = this._idleMonitor.add_idle_watch(IDLE_TIME_TO_CLOSE, Lang.bind(this,
                        function(monitor) {
                            this.closeWhenActive();
                        }
                    ));
                }
                else {
                    this.closeWhenActive();
                }

                return false;
            }
        ));
    },

    close: function(timestamp) {
        this._cancelCloseWhenActive();
        this._cancelOpenWhenIdle();

        this.parent(timestamp);
    },

    _cancelOpenWhenIdle: function() {
        if (this._openWhenIdleWatchId != 0) {
            this._idleMonitor.remove_watch(this._openWhenIdleWatchId);
            this._openWhenIdleWatchId = 0;
        }
    },

    openWhenIdle: function() {
        if (this.state == State.OPEN || this.state == State.OPENING) {
            return;
        }

        if (this._openWhenIdleWatchId == 0) {
            this._openWhenIdleWatchId = this._idleMonitor.add_idle_watch(IDLE_TIME_TO_OPEN, Lang.bind(this,
                function(monitor) {
                    this.open();
                }
            ));
        }
    },

    _cancelCloseWhenActive: function() {
        if (this._closeWhenActiveWatchId != 0) {
            this._idleMonitor.remove_watch(this._closeWhenActiveWatchId);
            this._closeWhenActiveWatchId = 0;
        }
    },

    closeWhenActive: function() {
        if (this.state == State.CLOSED || this.state == State.CLOSING) {
            return;
        }

        if (this._closeWhenActiveWatchId == 0) {
            this._closeWhenActiveWatchId = this._idleMonitor.add_user_active_watch(Lang.bind(this,
                function(monitor) {
                    this.close();
                }
            ));
        }
    },

    setElapsedTime: function(elapsed, state_duration) {
        let remaining = Math.ceil(state_duration - elapsed);
        let minutes = Math.floor(remaining / 60);
        let seconds = Math.floor(remaining % 60);

        this._timerLabel.set_text('%02d:%02d'.format(minutes, seconds));
    },

    setDescription: function(text) {
        this._description = text;
        this._descriptionLabel.text = text;
    },

    destroy: function() {
        this._cancelOpenWhenIdle();
        this._cancelCloseWhenActive();

        if (this._openIdleWatchId != 0) {
            this._idleMonitor.remove_watch(this._openIdleWatchId);
            this._openIdleWatchId = 0;
        }

        this.parent();
    }
});


const Source = new Lang.Class({
    Name: 'PomodoroNotificationSource',
    Extends: MessageTray.Source,

    _init: function() {
        this._icons = {};

        this.parent(_("Pomodoro"));
    },

    createIcon: function(size) {
        if (this._icons[size] === undefined)
        {
            let icon = new St.Icon({ icon_name: ICON_NAME,
                                     icon_size: size });
            icon.connect('destroy', Lang.bind(this, function() {
                delete this._icons[size];
            }));
            this._icons[size] = icon;
        }

        return this._icons[size];
    },

    close: function(close_tray) {
        source.emit('done-displaying-content', close_tray == true);
    }
});


const Notification = new Lang.Class({
    Name: 'PomodoroNotification',
    Extends: MessageTray.Notification,

    _init: function(source, title, description, params) {
        this.parent(source, title, description, params);

        // Force to show description along with title,
        // as this is private property, API might change
        try {
            this._titleFitsInBannerMode = true;
        }
        catch (error) {
            global.log('Pomodoro: ' + error.message);
        }
    },

    show: function() {
        if (!Main.messageTray.contains(this.source))
            Main.messageTray.add(this.source);

        if (this.source) {
            this.source.notify(this);
            this.emit('show');
        }
    },

    hide: function(close_tray) {
        if (close_tray) {
            Main.messageTray.close();
        }

        this.emit('done-displaying');

        if (!this.resident) {
            this.destroy();
        }
    },

    close: function(close_tray) {
        if (close_tray) {
            Main.messageTray.close();
        }

        this.emit('done-displaying');
        this.destroy();
    }
});


const PomodoroStart = new Lang.Class({
    Name: 'PomodoroStartNotification',
    Extends: Notification,

    _init: function(source) {
        this.parent(source,
                    _("Starting pomodoro"),
                    _("Now focus on your thing"),
                    null);
        this.setTransient(true);
    }
});


const PomodoroEnd = new Lang.Class({
    Name: 'PomodoroEndNotification',
    Extends: Notification,

    _init: function(source) {
        let title = _("Take a break!");
        let description = '';

        this.parent(source, title, description, null);

        this._settings = new Gio.Settings({ schema: 'org.gnome.pomodoro.preferences' });
        this._settings.connect('changed', Lang.bind(this, this._onSettingsChanged));

        this.setResident(true);
        this.addButton(Action.SWITCH_TO_PAUSE, "");
        this.addButton(Action.SWITCH_TO_POMODORO, _("Start pomodoro"));

        if (!this._bodyLabel) {
            this._bodyLabel = this.addBody("", null, null);
        }

        this._pause_switch_button = this.getButton(Action.SWITCH_TO_PAUSE);
        this._pause_switch_button.hide();

        this._short_break_duration = this._settings.get_double('short-break-duration');
        this._long_break_duration = this._settings.get_double('long-break-duration');
    },

    _onSettingsChanged: function() {
        this._short_break_duration = this._settings.get_double('short-break-duration');
        this._long_break_duration = this._settings.get_double('long-break-duration');
    },

    getButton: function(id) {
        let button = this._buttonBox.get_children().filter(function(b) {
            return b._actionId == id;
        })[0];

        return button;
    },

    updateButtons: function(is_long_pause, can_switch_pause) {
        let changed = false;
        let action_id = this._pause_switch_button._actionId;

        if (this._short_break_duration >= this._long_break_duration) {
            this._pause_switch_button.hide();
            return;
        }

        if (this._pause_switch_button.reactive != can_switch_pause) {
            this._pause_switch_button.reactive = can_switch_pause;
            this._pause_switch_button.can_focus = can_switch_pause;
        }

        if (is_long_pause && action_id != Action.SWITCH_TO_SHORT_PAUSE) {
            this._pause_switch_button._actionId = Action.SWITCH_TO_SHORT_PAUSE;
            this._pause_switch_button.set_label(_("Shorten it"));
            changed = true;
        }

        if (!is_long_pause && action_id != Action.SWITCH_TO_LONG_PAUSE) {
            this._pause_switch_button._actionId = Action.SWITCH_TO_LONG_PAUSE;
            this._pause_switch_button.set_label(_("Lengthen it"));
            changed = true;
        }

        if (changed) {
            this._pause_switch_button.show();
        }
    },

    setElapsedTime: function(elapsed, state_duration) {
        let remaining = Math.ceil(state_duration - elapsed);
        let minutes = Math.round(remaining / 60);
        let seconds = Math.floor(remaining % 60);
        let message = (remaining <= 45)
                ? ngettext("You have %d second left",
                           "You have %d seconds left", seconds).format(seconds)
                : ngettext("You have %d minute left",
                           "You have %d minutes left", minutes).format(minutes);

        let is_long_pause = state_duration > this._short_break_duration;
        let can_switch_pause = elapsed < this._short_break_duration;

        this._bannerLabel.set_text(message);
        this._bodyLabel.set_text(message);

        this.updateButtons(is_long_pause, can_switch_pause);
    }
});


const PomodoroEndReminder = new Lang.Class({
    Name: 'PomodoroEndReminderNotification',
    Extends: Notification,

    _init: function(source) {
        let title = _("Hey, you're missing out on a break")
        let description = '';

        this.parent(source, title, description, null);

        this.setTransient(true);
        this.setUrgency(MessageTray.Urgency.LOW);

        this._timeoutSource = 0;
        this._interval = 0;
        this._timeout = 0;
    },

    _onTimeout: function() {
        let display = global.screen.get_display();
        let idleTime = parseInt((display.get_current_time_roundtrip() - display.get_last_user_time()) / 1000);

        // No need to notify if user seems to be away. We only monitor idle time
        // based on X11, and not Clutter scene which should better reflect to real work
        if (idleTime < this._timeout * REMINDER_ACCEPTANCE)
            this.show();
        else
            this.unschedule();

        this.schedule();
        return false;
    },

    schedule: function() {
        let intervals = REMINDER_INTERVALS;
        let reschedule = this._timeoutSource != 0;

        if (this._timeoutSource) {
            GLib.source_remove(this._timeoutSource);
            this._timeoutSource = 0;
        }

        if (this._interval < intervals.length) {
            this._timeout = intervals[this._interval];
            this._timeoutSource = Mainloop.timeout_add_seconds(this._timeout,
                                                                Lang.bind(this, this._onTimeout));
        }

        if (!reschedule)
            this._interval += 1;
    },

    unschedule: function() {
        if (this._timeoutSource) {
            GLib.source_remove(this._timeoutSource);
            this._timeoutSource = 0;
        }

        this._interval = 0;
        this._timeout = 0;
    },

    destroy: function() {
        this.unschedule();
        this.parent();
    }
});


const Issue = new Lang.Class({
    Name: 'PomodoroIssueNotification',
    Extends: Notification,

    _init: function(source) {
        let extension = ExtensionUtils.getCurrentExtension();
        let service   = extension.metadata['service'];
        let url       = extension.metadata['url'];
        let installed = Gio.file_new_for_path(service).query_exists(null);

        let title = _("Could not run pomodoro");
        let description = installed
                    ? _("Something went badly wrong...")
                    : _("Looks like gnome-pomodoro is not installed");

        this.parent(source, title, description, {});
        this.setUrgency(MessageTray.Urgency.HIGH);
        this.setTransient(true);

        // TODO: Check which distro running, install via package manager

        // FIXME: Gnome Shell crashes due to missing schema file,
        //        so offer to install the app doesn't work right now

        if (installed)
            this.addButton(Action.REPORT_BUG, _("Report issue"));
        else
            this.addButton(Action.VISIT_WEBSITE, _("Install"));

        this.connect('action-invoked', Lang.bind(this, function(notification, action) {
            notification.hide();
            if (action == Action.REPORT_BUG)
                Util.trySpawnCommandLine('xdg-open ' + GLib.shell_quote(url));
        }));
    }
});
