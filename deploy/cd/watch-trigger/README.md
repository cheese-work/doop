# CD freshness watch trigger (CHE-10354)

X99 systemd user timer that dispatches `cd-freshness-watch.yml` on `cheese/main` every 15 minutes, because GitHub's
cron skips slots (CHE-9479). It never dispatches `cd-deploy.yml`.

Install (X99, user `congvc`):

    install -D -m755 cd-watch-trigger.sh ~/.local/share/cd-watch-trigger/cd-watch-trigger.sh
    install -m644 cd-watch-trigger.service cd-watch-trigger.timer ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now cd-watch-trigger.timer

Check: `systemctl --user list-timers cd-watch-trigger.timer`, `journalctl --user -u cd-watch-trigger.service -n 20`.

Remove (cleanup handle):

    systemctl --user disable --now cd-watch-trigger.timer
    rm ~/.config/systemd/user/cd-watch-trigger.{service,timer}
    rm -r ~/.local/share/cd-watch-trigger && systemctl --user daemon-reload
