msg = update

wip: 
	make update msg="WIP"

update:
	git add .
	git commit -m "$(msg)"
	git push origin main


iw:
	./bin/install_website

tag:
	git tag rel523b1
	git push origin --tags


copyhere:
	cp ~/Library/LaunchAgents/com.toddhoff.tesla-run-due.plist .

launch:
	cp ./com.toddhoff.tesla-run-due.plist ~/Library/LaunchAgents/com.toddhoff.tesla-run-due.plist
	launchctl unload ~/Library/LaunchAgents/com.toddhoff.tesla-run-due.plist 2>/dev/null || true
	launchctl load ~/Library/LaunchAgents/com.toddhoff.tesla-run-due.plist
	launchctl start com.toddhoff.tesla-run-due

cleardefaults:
	xcrun simctl --set previews delete all
