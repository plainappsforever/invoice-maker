Pod::Spec.new do |s|
  s.name           = 'TextScan'
  s.version        = '1.0.0'
  s.summary        = 'On-device text recognition for Invoice Maker'
  s.description    = 'Apple Vision text recognition of a photo (business cards, letterheads); VisionKit availability.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Vision', 'VisionKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
