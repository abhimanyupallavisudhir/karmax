#!/bin/bash
mkdir -p "$1" && cd "$1" && git init -q && git -c user.email=dev@example.com -c user.name=dev commit -q --allow-empty -m init
