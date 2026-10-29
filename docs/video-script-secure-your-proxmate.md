# Secure your ProxMate: video script

Part three of the ProxMate series. Part one installed ProxMate and handed Mike his first VM, and part two
filled the Template Store and went through every console. This one locks the server down before anyone else
moves in: two-factor authentication for the admin, recovery codes, an invite that requires a second factor,
password resets without email, access windows that run out, the Audit Log, and every security setting on the
admin side. Part four moves to HTTPS for passkeys and single sign-on with Keycloak.

Recorded on the same Ubuntu desktop as parts one and two, against the same real Proxmox VE node.

- **Working title:** Secure your ProxMate: two-factor sign-in, safe invites and the security settings (v1.3)
- **Length:** about 2,150 spoken words; with the real waits sped up it should land near 14 minutes
- **Voice:** Kokoro `af_heart` at normal speed, the same voice as parts one and two
- **Narration:** written in the creator's voice from part two's take three, to the rules in
  [narration-style-guide.md](narration-style-guide.md)
- **Follows:** the docs at https://proxmate.host/docs/auth, https://proxmate.host/docs/security and
  https://proxmate.host/docs/config

## Lab used in the recording

| Thing | Value |
|---|---|
| Presenter's desktop | Ubuntu 24.04, user `alex`, Chromium, and KeePassXC 2.7.6 as the authenticator app |
| ProxMate | v1.3.4 on the `proxmate` box, http://192.168.1.50:3000, plain HTTP and no email server, signed in as Alex (admin) |
| Proxmox VE node | the real Proxmox VE 9.2.2 node `pve1`, container disks on its `local` directory storage |
| Container template on Proxmox | `debian-12-standard_12.12-1_amd64.tar.zst` |
| Friends | Mike (account from part one) in a guest window, and Sam (new this episode) in an incognito window |
| Made on camera | Alex's two-factor authentication, an API token (revoked on camera), Sam's invite, account and `sam-debian` container, Mike's password reset, a kiosk exit PIN, an app-database snapshot |

What is a stand-in, and said so in the narration or the notes:

- KeePassXC on the desktop stands in for an authenticator app on a phone. The QR code can't be scanned on the
  recording rig, so the setup key is copied instead. Sam's authenticator is a second KeePassXC entry.
- Sam's access end date is moved into the past off camera, and ProxMate's backend is restarted so its hourly
  access check runs right away. Waiting seven days is the only other way to film it.
- The sign-in rate limit is raised for the recording session, because every window on the desktop shares one
  address. It is put back to the default of 20 afterwards. The lockout is explained from the docs, not triggered.
- Every password, setup key, recovery code, token and invite link on screen belongs to a throwaway lab account,
  deleted after the recording.

Markers: `[ON SCREEN: ...]` is what the viewer sees. `[FF]` is a real wait that is sped up in the edit, with a
small fast-forward badge. Start times are added once the cut exists.

---

## V01 · Cold open

[ON SCREEN: recorded last. Sam's incognito window: the sign-in page, email and password, Sign in. The "Two-factor authentication" card with its "Authentication code" box. KeePassXC beside it: right-click Sam's entry, Copy TOTP. Paste, Verify, and Sam's dashboard with the "Your compute access ends in 7 days." banner.]

Welcome back to part three of the Set Up Your ProxMate series.

This is our new friend Sam signing in. After the password, ProxMate asks for a six-digit code from an authenticator app.

Today we will be locking down ProxMate. We will set up two-factor authentication, invite a friend who has to use it, and go through every security setting.

We'll start with my own admin account, because that account can change everything else.

## V02 · Where security lives

[ON SCREEN: Alex's dashboard. Open the user menu at the top right: name, email, the Administrator badge, Security, Sign out. Then the sidebar's Admin section: Invites, Users, Audit Log, Settings.]

Every account has its own Security page. You'll find it in the menu under your name, up in the top right corner.

Our friends get this page too, so they can protect their own accounts.

As the admin, I also have the Admin section in the sidebar. Invites, Users, the Audit Log, and Settings hold the rest of the security options.

## V03 · Turn on two-factor authentication

[ON SCREEN: Security page: "Two-factor authentication is off", Set up 2FA. The setup card: the QR code, then "Can't scan? Enter this key manually:" and the key. Double-click the key, Ctrl+C. KeePassXC: an entry named ProxMate, right-click, TOTP, Set up TOTP…, paste into Secret Key, Default settings (RFC 6238) stays selected, OK. Right-click, Copy TOTP. Back in Chromium: paste into "6-digit code", Enable 2FA, the toast "Two-factor authentication is on."]

Two-factor authentication is off on my account, so I'll click the Set up 2FA button.

On a phone, you would scan this QR code with an app like Google Authenticator, 1Password, or Authy.

I'm using KeePassXC on this desktop instead, so I'll copy the key under Can't scan. There is no copy button, so I'm double-clicking the key to select it.

Every click on Set up 2FA makes a brand new key, so always use the one that's on your screen right now.

In KeePassXC, I made an entry called ProxMate. I'll right-click it, open the TOTP menu, and pick Set up TOTP.

TOTP is the six-digit code that changes every thirty seconds. I'm pasting the key into Secret Key and keeping the default settings, because ProxMate uses the standard ones.

Now I'll copy the current code with Copy TOTP, paste it into the code box, and click Enable 2FA.

## V04 · Save your recovery codes

[ON SCREEN: the "Save your recovery codes" card at the top of the page: ten codes in two columns, Copy all, I've saved them. Then the card below: "Two-factor authentication is on" and "10 recovery codes left."]

ProxMate now shows ten recovery codes. Each one works once, in case you lose your authenticator.

They won't be shown again, so I'll click Copy all and keep them somewhere safe.

Keep them away from your authenticator, like on paper or in a different password manager. If both live in one place, losing that one place means losing both.

Once they're saved, I'll click I've saved them. The card below now says two-factor authentication is on, with ten recovery codes left.

## V05 · Signing in with a code

[ON SCREEN: user menu, Sign out, the sign-in page. Email and password, Sign in. The "Two-factor authentication" card: "Authentication code". KeePassXC: Copy TOTP with Ctrl+T. Paste, Verify, the dashboard.]

Let's see what signing in looks like now. I'll sign out from the menu and sign back in with my email and password.

Instead of the dashboard, ProxMate asks for an authentication code. In KeePassXC, Control T copies the current code.

I'll paste it in and click Verify, and I'm back on the dashboard.

ProxMate also accepts the code right before and right after this one. So your computer's clock only has to be within about thirty seconds of the server's clock.

## V06 · If you lose your authenticator

[ON SCREEN: sign out, sign in with email and password, type one recovery code into "Authentication code", Verify. Security page: "9 recovery codes left." Point at the Disable 2FA box under it.]

Now let's pretend I lost the device with my authenticator on it. I'll sign in again, and this time I'm typing one of my recovery codes.

It goes in the same box as the code, and the dash and capital letters don't matter.

Back on the Security page, it now says nine recovery codes left, because that one is used up.

To get new codes, you would type a current code here and click Disable 2FA. Then you set it up again with a new key.

Please don't skip saving your recovery codes. No admin can turn off someone else's two-factor authentication, and that includes me.

If you lose both your authenticator and your codes, getting back in means editing the database by hand.

## V07 · The rest of the Security page

[ON SCREEN: scroll down the Security page. Passkeys card: "No passkeys yet.", Add a passkey. SSH keys card. API tokens card: Token name terraform, Create token, the one-time panel "Your new token — copy it now, it won't be shown again:", Copy, Done, the row "pm_… · never used", then the trash icon and "API token revoked." Email preferences with its three checkboxes.]

Further down are passkeys, which let you sign in with your device's fingerprint reader or a security key.

Browsers only allow passkeys over HTTPS, and this server is still on plain HTTP, so passkeys will wait for part four.

The SSH keys card is the one we used in part two. Below it are API tokens, for scripts and tools like Terraform that talk to ProxMate for you.

I'll make a token called terraform. ProxMate shows the token only once, so you have to copy it right away.

A token can do anything you can do, so treat it like a password. It can't change anything on this Security page, though.

When a token isn't needed anymore, the trash icon revokes it right away, without asking first.

At the bottom, Email preferences picks which optional emails you get. This lab has no email server set up, so nothing is sent.

## V08 · Settings, the Proxmox tab

[ON SCREEN: Admin, Settings, the Proxmox tab. The Proxmox connection card: point at Verify TLS certificate (unticked) and Proxmox pool (optional). Test connection, the "Connected to Proxmox VE 9.2.2" toast. Scroll to Tenant network isolation: its description, Apply isolation firewall to new VMs (ticked), the amber "Not enforced yet." note, Management subnet, and Enable enforcement, which is not clicked.]

Now for the admin side. Settings has five tabs, and the first one is Proxmox.

Verify TLS certificate is off here, because my Proxmox node still uses the certificate it made for itself.

Once Proxmox has a certificate you trust, turn this on, so ProxMate knows it's talking to the real server.

In part one, I used a root token to keep things simple. The docs also have a script that makes a token with only the permissions ProxMate needs.

If you fill in a Proxmox pool, every guest ProxMate makes goes into it. Then the token can be limited to that pool.

Test connection checks the token, and it warns you when a permission is missing.

Further down is tenant network isolation. It gives every new VM a firewall that blocks your LAN, the other VMs, and the Proxmox host. The VM can still reach the internet.

The amber note says it isn't enforced yet, because those rules only work once the Proxmox cluster firewall is on.

Enable enforcement turns that firewall on. First, it adds a rule so your management network can still reach Proxmox.

I'm leaving my lab node alone, but on your own server, the docs say to do this before you invite anyone.

## V09 · Settings, the Notifications tab

[ON SCREEN: the Notifications tab. The Email (SMTP) card: its description, Host, Port, From address. The Notifications card: Webhook URL, ntfy, Telegram, then Notify me about with all five ticked. Point at Account locked (brute-force).]

The Notifications tab starts with email. Without an email server, a forgotten password goes to the admin instead, and we'll see that with Mike in a minute.

Below that, ProxMate can alert you through a webhook for Discord or Slack, through ntfy, or through Telegram.

Account locked is checked in this list, so you hear about it when someone keeps guessing a password.

This lab doesn't have a channel set up yet, so these alerts have nowhere to go.

## V10 · Settings, the Access tab

[ON SCREEN: the Access tab. The Single sign-on (OIDC) card: the description naming Keycloak, Redirect / callback URL, Issuer URL with its placeholder, Client ID, Client secret, Groups claim, Admin group, the two checkboxes. Nothing is typed or saved. Then the Kiosk mode card: type a PIN, Set PIN, "Kiosk exit PIN set."]

The Access tab is where single sign-on lives. It lets people sign in through an identity provider like Keycloak, and passwords keep working alongside it.

Keycloak is popular in homelabs, and it's the one we're setting up in part four.

Keycloak has to be on HTTPS for this to work, so this card stays empty for now.

When we fill it in, the callback URL at the top goes into Keycloak. Members of an admin group in Keycloak can also become ProxMate admins.

Sign-ins through Keycloak skip ProxMate's own code, so the second step for those accounts gets set up in Keycloak.

Kiosk mode is a full-screen wall panel. An exit PIN stops someone walking past from tapping out into the admin console.

I'll set a PIN here. My account password still works too, so I can't lock myself out of my own panel.

## V11 · Settings, the Maintenance tab

[ON SCREEN: the Maintenance tab. Updates: Check for updates, "You're on the latest version (v1.3.4)." App-database backups: the description, Backup directory /var/backups/proxmate, Keep 7, Back up now, the "Snapshot written: …" toast.]

On the Maintenance tab, Check for updates looks for a newer ProxMate release. I'm already on the latest one, version 1.3.4.

App-database backups save ProxMate's own database every night, with your users, VM records, and settings.

I'll click Back up now to make one right away.

Point the backup directory at another machine's share if you can, so a dead host doesn't take the backups with it.

Restoring one also needs the encryption key we backed up in part one, so always keep a copy of both.

## V12 · Invite Sam with two-factor required

[ON SCREEN: Admin, Invites. Create an invite: Max vCPU 4, Max RAM (GB) 8, Max storage (GB) 100. Invite link expires in: 1 day. Compute access: 7 days. Label: Sam. Tick "Require two-step authentication — …". Generate invite, "Invite created.", the link box. The All invites row: Sam, the 2FA badge, Active. Triple-click the link, Ctrl+C.]

Now let's invite our new friend Sam. This time, two-factor authentication is required before Sam can use anything.

I'm keeping the usual quota, and I'm setting the invite link to expire in one day, so it doesn't sit around.

Compute access is how long Sam can use the cluster after signing up. I'll give Sam seven days, and I can change that later in Users.

Then I'll check Require two-step authentication. ProxMate calls it two-step here, and it means the same thing as two-factor.

Sam's invite now has a 2FA badge in the list.

On plain HTTP, the browser blocks the Copy button, so I'm selecting the link and copying it myself.

Send it to Sam somewhere private, because anyone who has the link can create the account.

## V13 · Sam signs up

[ON SCREEN: an incognito window: paste the link. Create your account: "You've been invited as "Sam"", the quota tiles, the amber two-step note. Display name Sam, Email sam@example.com, Password, Confirm password, Create account. The toast, then "Set up two-step authentication": Set up authenticator app, "Can't scan? Enter this key:". KeePassXC: Sam's entry, Set up TOTP…, paste, OK, Copy TOTP. Paste into "6-digit code", Enable. Save your recovery codes, "I've saved them — sign in". The sign-in page: email, password, Sign in, the code, Verify, Sam's dashboard.]

This private window stands in for Sam's computer, and a second KeePassXC entry stands in for Sam's phone.

The invite page shows Sam's quota and a note that two-step authentication is required.

Sam fills in a name, an email, and a password, then clicks Create account.

Instead of the dashboard, Sam lands on the setup page. Passkeys need HTTPS, so Sam picks the authenticator app.

Sam goes through the same steps I did, with the key, KeePassXC, and the six-digit code.

Sam's recovery codes come up next, and clicking I've saved them goes back to the sign-in page.

Setup doesn't sign Sam in, so Sam signs in for the first time with the password and a code.

If Sam had closed the setup page partway through, signing in with the password would bring it right back.

## V14 · Sam's dashboard

[ON SCREEN: Sam's dashboard: the "Your compute access ends in 7 days." banner with its date and "Nothing is deleted". Sam creates a small Debian container, 1 vCPU, 512 MB and 4 GB, from the debian-12-standard template. FF until it's Running.]

Because Sam's access has an end date, the dashboard shows a banner with seven days left.

It says Sam's machines will be powered off on that date, and that nothing will be deleted.

Sam's going to start a small Debian container, the same way we made one in part two.

Creating it takes a little over a minute, so I'm speeding through the wait.

[FF]

Sam's container is running now, and it counts against Sam's quota.

## V15 · Mike forgot his password

[ON SCREEN: a guest window: the sign-in page, Forgot your password?. Reset your password: mike@example.com, Send reset request, "Request received". Alex's window: reload Users, the "1 password reset request" card, the red "reset requested" badge on Mike's row. The key icon, "Reset password for Mike", Generate a random password, Set password, the toast.]

Mike has forgotten his password from part one, so in this window, he clicks Forgot your password and sends a reset request.

Without an email server, ProxMate can't send a reset link, so the request comes to the admin instead.

ProxMate doesn't notify me, so the request shows up the next time I open the Users page.

Mike's row has a reset requested badge. I'll click the key icon and generate a random password.

Setting it signs Mike out everywhere and removes his API tokens. It doesn't turn off two-factor authentication.

Send the new password to Mike somewhere private, and he can sign in with it.

## V16 · Wrong passwords and lockouts

[ON SCREEN: https://proxmate.host/docs/config, the AUTH_RATE_LIMIT_MAX and AUTH_LOCKOUT_MAX / AUTH_LOCKOUT_MINUTES rows. Then https://proxmate.host/docs/security, the brute-force line in the threat model.]

ProxMate also protects the sign-in page from someone guessing passwords. I won't set these off on camera, so we'll go over them in the docs.

Ten wrong passwords in a row lock that account for fifteen minutes. Ten wrong two-factor codes lock it too.

While it's locked, the sign-in page only says the password is wrong, and an admin can't lift the lock early.

On top of that, one address gets twenty sign-in attempts every fifteen minutes before ProxMate makes it wait.

A lock sends the alert we saw on the Notifications tab, and it also shows up in the Audit Log.

## V17 · When access ends

[ON SCREEN: a text card: "Off camera: Sam's end date moved into the past, ProxMate restarted so its access check runs now." Alex's window: Users, Sam's row with the red Suspended badge, and sam-debian Stopped. Sam's window, still signed in: reload, "Your compute access has ended." A fresh sign-in for Sam: the toast "Your compute access ended on … Your machines and data are safe …".]

Sam's seven days would take a week to run out, so I moved the end date into the past off camera.

ProxMate checks for ended access once an hour, and I restarted it so the check would run right away.

It marked Sam as Suspended and shut the container down.

Sam's window was still open, and it now says Sam's compute access has ended.

Signing in again is refused, with a message saying the machines and data are safe.

None of Sam's things were deleted. The container is stopped, and everything on it is still there.

## V18 · Giving access back

[ON SCREEN: Alex: Users, click Sam, the edit dialog: Compute access, its "Suspended" hint, choose 7 days from today, Save quota, the toast. The row loses Suspended. Sam's window: sign in with password and code, the dashboard, sam-debian Stopped, Actions, Start.]

To give Sam more time, I'll click Sam's name in Users and pick seven days from today under Compute access.

Saving it lifts the suspension right away.

Sam's container doesn't start back up by itself, so Sam signs in and starts it from the Actions menu.

If you ever delete a user instead, also revoke their old invite on the Invites page. In this version, deleting a user makes that invite link work again.

## V19 · The Audit Log

[ON SCREEN: Admin, Audit Log, Refresh. Columns When, Actor, Action, Details, IP. Scroll the rows: invite.create Sam, auth.register, auth.2fa_enabled, auth.login 2fa, apitoken.create and apitoken.revoke, admin.reset_password, auth.login_blocked compute access expired, vm.stop, admin.access_suspended, admin.update_access (suspension lifted).]

Everything we did today is in the Audit Log. It shows who did what, when, and from which address.

There's Sam's invite, the sign-up, two-factor being turned on, and each sign-in with a code.

Mike's password reset is here, and so are the blocked sign-in, the suspension, and the access I gave back.

Failed sign-ins and wrong codes show up in red, so they stand out when you scroll.

The page doesn't refresh itself, so click Refresh to see new entries.

## V20 · A checklist for your own server

[ON SCREEN: https://proxmate.host/docs/security, the checklist table, scrolled slowly.]

The security page in the ProxMate docs ends with a checklist that you can work through on your own server.

We did the encryption key backup in part one, and two-factor authentication for invites today.

Turning on the cluster firewall and using a limited Proxmox token are both on it, along with regular database backups.

HTTPS is near the top of the list, and that's where part four begins.

## V21 · Wrap-up

[ON SCREEN: Alex's Security page with "Two-factor authentication is on", then the Access tab's empty single sign-on card.]

That's it for part three of the series.

In part four, we'll put ProxMate on HTTPS with our own certificate, add passkeys, and set up single sign-on with Keycloak.

Let me know in the comments which authenticator app you use, and thanks for watching.

## End card · 7.5 seconds, no narration

[ON SCREEN: the same animated end card as parts one and two: the ProxMate badge, "ProxMate.", the tagline "Your cluster *shared* safely", and "Visit proxmate.host to learn more".]
