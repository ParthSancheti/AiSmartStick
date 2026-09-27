package com.getcapacitor.annotation; public @interface Permission { String alias() default ""; String[] strings() default {}; }
