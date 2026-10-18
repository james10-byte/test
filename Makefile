.PHONY: install test test-browser test-all shell-check docker-build up down logs backup

install:
	npm install

test:
	npm test

test-browser:
	npm run test:browser

test-all:
	npm run test:all

shell-check:
	for file in install.sh scripts/*.sh scripts/lib/*.sh scripts/docker/*.sh; do bash -n $$file; done

docker-build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f app

backup:
	bash scripts/backup.sh
