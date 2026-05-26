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


copy:
	cp ~/Library/LaunchAgents/com.toddhoff.tesla-run-due.plist .

cleardefaults:
	xcrun simctl --set previews delete all
